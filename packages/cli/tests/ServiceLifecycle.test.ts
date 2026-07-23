import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('marifold service lifecycle', () => {
  it('exits a duplicate start and terminates cleanly after SIGINT', async () => {
    const cliEntry = path.resolve(__dirname, '../dist/index.js');
    expect(fs.existsSync(cliEntry), 'Build the CLI before running its lifecycle integration test.').toBe(true);

    const first = startService(cliEntry, fixtureConfig());
    const firstOutput = await waitForOutput(first, /Marifold service listening at (http:\/\/127\.0\.0\.1:\d+)/);
    const address = firstOutput.match(/Marifold service listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    expect(address).toBeDefined();
    expect(await fetch(`${address}/health`).then(response => response.json())).toMatchObject({
      ok: true,
      service: 'marifold',
    });

    const port = new URL(address!).port;
    const duplicate = startService(cliEntry, fixtureConfig(), port);
    const duplicateExit = await waitForExit(duplicate, 4_000);
    expect(duplicateExit.code).toBe(1);
    expect(duplicateExit.signal).toBeNull();
    expect(duplicateExit.output).toContain('EADDRINUSE');

    const stoppedPromise = waitForExit(first, 6_000);
    first.kill('SIGINT');
    const stopped = await stoppedPromise;
    expect(stopped).toMatchObject({ code: 0, signal: null });
    expect(stopped.output).toContain('Stopping Marifold service (SIGINT)');
    await expect(fetch(`${address}/health`)).rejects.toThrow();
  }, 15_000);
});

function fixtureConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-service-lifecycle-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'config.toml');
  const tomlPath = (value: string): string => JSON.stringify(value);
  fs.writeFileSync(configPath, [
    '[default]',
    'provider = "ollama"',
    'model = "test-model"',
    'profile = "default"',
    '',
    '[models]',
    'options = ["ollama/test-model"]',
    '',
    '[paths]',
    `profiles_dir = ${tomlPath(path.join(dir, 'profiles'))}`,
    `sessions_db = ${tomlPath(path.join(dir, 'sessions.db'))}`,
    `tasks_dir = ${tomlPath(path.join(dir, 'tasks'))}`,
    `schedules_dir = ${tomlPath(path.join(dir, 'schedules'))}`,
    '',
    '[providers.ollama]',
    'type = "ollama"',
    'base_url = "http://127.0.0.1:11434"',
    '',
  ].join('\n'));
  return configPath;
}

function startService(cliEntry: string, configPath: string, port = '0'): ChildProcess {
  const child = spawn(process.execPath, [
    cliEntry,
    '--config',
    configPath,
    'service',
    '--port',
    port,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  children.add(child);
  return child;
}

function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Service exited before ${pattern} (code=${code}, signal=${signal}). Output:\n${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer | string): void => { output += chunk.toString(); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for service exit. Output:\n${output}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      children.delete(child);
      resolve({ code, signal, output });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}
