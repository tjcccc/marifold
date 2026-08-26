import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    const statePath = path.join(dir, 'service-state', 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pid?: number };
      if (state.pid) process.kill(state.pid, 'SIGKILL');
    } catch {
      // Best-effort cleanup for a failed daemon lifecycle assertion.
    }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('marifold service lifecycle', () => {
  it('rejects a second managed instance and terminates cleanly after SIGINT', async () => {
    const cliEntry = path.resolve(__dirname, '../dist/index.js');
    expect(fs.existsSync(cliEntry), 'Build the CLI before running its lifecycle integration test.').toBe(true);

    const configPath = fixtureConfig();
    const first = startService(cliEntry, configPath);
    const firstOutput = await waitForOutput(first, /Marifold service available at (http:\/\/127\.0\.0\.1:\d+)/);
    const address = firstOutput.match(/Marifold service available at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    expect(address).toBeDefined();
    expect(await fetch(`${address}/health`).then(response => response.json())).toMatchObject({
      ok: true,
      service: 'marifold',
    });
    const webShell = await fetch(address!);
    expect(webShell.status).toBe(200);
    expect(webShell.headers.get('content-type')).toContain('text/html');
    expect(await webShell.text()).toContain('<title>marifold</title>');

    const port = new URL(address!).port;
    const duplicate = startService(cliEntry, configPath, port);
    const duplicateExit = await waitForExit(duplicate, 4_000);
    expect(duplicateExit.code).toBe(1);
    expect(duplicateExit.signal).toBeNull();
    expect(duplicateExit.output).toContain('Marifold service is already running');

    const status = await runCli(cliEntry, configPath, ['status']);
    expect(status.code).toBe(0);
    expect(status.output).toContain('Marifold service: running');
    expect(status.output).toContain('Mode:    foreground');

    const stoppedPromise = waitForExit(first, 6_000);
    first.kill('SIGINT');
    const stopped = await stoppedPromise;
    expect(stopped).toMatchObject({ code: 0, signal: null });
    expect(stopped.output).toContain('Stopping Marifold service (SIGINT)');
    await expect(fetch(`${address}/health`)).rejects.toThrow();

    const stoppedStatus = await runCli(cliEntry, configPath, ['status']);
    expect(stoppedStatus.code).toBe(1);
    expect(stoppedStatus.output).toContain('Marifold service: stopped');
  }, 15_000);

  it('starts, reports, logs, restarts with the same options, deduplicates, and stops a daemon', async () => {
    const cliEntry = path.resolve(__dirname, '../dist/index.js');
    const configPath = fixtureConfig();
    const started = await runCli(cliEntry, configPath, ['service', 'start', '--daemon', '--port', '0', '--log'], 12_000);
    expect(started.code).toBe(0);
    expect(started.output).toMatch(/Marifold service available at http:\/\/127\.0\.0\.1:\d+/);
    expect(started.output).toMatch(/Marifold service started in background \(PID \d+\)/);
    expect(started.output).not.toContain('Web UI: serving');
    expect(started.output).not.toContain('CORS: allowing');
    const startedPid = Number(started.output.match(/PID (\d+)/)?.[1]);

    const status = await runCli(cliEntry, configPath, ['status']);
    expect(status.code).toBe(0);
    expect(status.output).toContain('Mode:    daemon');
    expect(status.output).toContain('Access:  loopback');
    const address = status.output.match(/Marifold service available at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    expect(address).toBeDefined();
    expect(await fetch(`${address}/health`).then(response => response.json())).toMatchObject({
      ok: true,
      service: 'marifold',
    });

    const logPath = path.join(serviceStateDir(configPath), 'service.log');
    await waitForFileOutput(logPath, /Marifold service available at/);
    const loggedStatus = await runCli(cliEntry, configPath, ['status', '--logs']);
    expect(loggedStatus.code).toBe(0);
    expect(loggedStatus.output).toContain('Recent logs (last 100 lines):');
    expect(loggedStatus.output).toContain('Marifold service available at');

    const restarted = await runCli(cliEntry, configPath, ['service', 'restart'], 12_000);
    expect(restarted.code).toBe(0);
    expect(restarted.output).toContain(`Marifold service stopped (PID ${startedPid}). Restarting...`);
    expect(restarted.output).toMatch(/Marifold service started in background \(PID \d+\)/);
    const restartedPid = Number(restarted.output.match(/started in background \(PID (\d+)\)/)?.[1]);
    expect(restartedPid).not.toBe(startedPid);

    const restartedStatus = await runCli(cliEntry, configPath, ['status']);
    expect(restartedStatus.code).toBe(0);
    expect(restartedStatus.output).toContain('Mode:    daemon');
    const restartedAddress = restartedStatus.output.match(/Marifold service available at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    expect(restartedAddress).toBeDefined();
    expect(await fetch(`${restartedAddress}/health`).then(response => response.json())).toMatchObject({
      ok: true,
      service: 'marifold',
    });

    const state = JSON.parse(fs.readFileSync(path.join(serviceStateDir(configPath), 'state.json'), 'utf8')) as {
      launch?: Record<string, unknown>;
    };
    expect(state.launch).toMatchObject({
      host: '127.0.0.1',
      port: '0',
      log: true,
      tokenSource: 'config',
    });

    const duplicate = await runCli(cliEntry, configPath, ['service', 'start', '--daemon', '--port', '0']);
    expect(duplicate.code).toBe(1);
    expect(duplicate.output).toContain('Marifold service is already running');

    const stopped = await runCli(cliEntry, configPath, ['service', 'stop'], 8_000);
    expect(stopped.code).toBe(0);
    expect(stopped.output).toMatch(/Marifold service stopped \(PID \d+\)/);
    await expect(fetch(`${restartedAddress}/health`)).rejects.toThrow();

    const stoppedStatus = await runCli(cliEntry, configPath, ['status']);
    expect(stoppedStatus.code).toBe(1);
    expect(stoppedStatus.output).toContain('Marifold service: stopped');
  }, 35_000);

  it('removes public mode and restarts legacy launch state as private without persisting raw tokens', async () => {
    const cliEntry = path.resolve(__dirname, '../dist/index.js');
    const configPath = fixtureConfig();
    const token = 'restart-test-secret';
    const removed = await runCli(cliEntry, configPath, ['service', '--public']);
    expect(removed.code).toBe(1);
    expect(removed.output).toContain("unknown option '--public'");

    const started = await runCli(cliEntry, configPath, [
      'service', 'start', '--daemon', '--host', '0.0.0.0', '--port', '0', '--token', token,
      '--cors-origin', 'http://127.0.0.1:5173', '--verbose',
    ], 12_000);
    expect(started.code).toBe(0);
    expect(started.output).toMatch(/Marifold service available at:\n  http:\/\/127\.0\.0\.1:\d+/);
    expect(started.output).toMatch(/Bind: http:\/\/0\.0\.0\.0:\d+/);
    expect(started.output).toContain('Web UI: serving');
    expect(started.output).toContain('CORS: allowing http://127.0.0.1:5173');

    const statePath = path.join(serviceStateDir(configPath), 'state.json');
    let stateText = fs.readFileSync(statePath, 'utf8');
    expect(stateText).not.toContain(token);
    expect(JSON.parse(stateText)).toMatchObject({
      launch: { host: '0.0.0.0', tokenSource: 'raw' },
    });
    expect(JSON.parse(stateText).launch).not.toHaveProperty('publicAccess');

    // Simulate state left by a pre-removal daemon. The old process remains
    // visible with an explicit warning; restart ignores the legacy flag and
    // launches the replacement under the permanent private-network policy.
    const legacyState = JSON.parse(stateText) as { launch: Record<string, unknown> };
    legacyState.launch.publicAccess = true;
    fs.writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    const missingToken = await runCli(cliEntry, configPath, ['service', 'restart']);
    expect(missingToken.code).toBe(1);
    expect(missingToken.output).toContain('service restart --token <token>');
    const legacyStatus = await runCli(cliEntry, configPath, ['status']);
    expect(legacyStatus.code).toBe(0);
    expect(legacyStatus.output).toContain('Access:  legacy-public');
    expect(legacyStatus.output).toContain('restart this legacy service');

    const restarted = await runCli(cliEntry, configPath, ['service', 'restart', '--token', token], 12_000);
    expect(restarted.code).toBe(0);
    expect(restarted.output).toContain('Restarting...');
    expect(restarted.output).toContain('Marifold service available at:');
    expect(restarted.output).not.toContain('Bind:');
    expect(restarted.output).not.toContain('Web UI: serving');
    expect(restarted.output).not.toContain('CORS: allowing');
    stateText = fs.readFileSync(statePath, 'utf8');
    expect(stateText).not.toContain(token);
    expect(JSON.parse(stateText).launch).not.toHaveProperty('publicAccess');
    const privateStatus = await runCli(cliEntry, configPath, ['status']);
    expect(privateStatus.output).toContain('Access:  private');

    const stopped = await runCli(cliEntry, configPath, ['service', 'stop'], 8_000);
    expect(stopped.code).toBe(0);
  }, 30_000);
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
    env: cliEnv(configPath),
  });
  children.add(child);
  return child;
}

function runCli(
  cliEntry: string,
  configPath: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const child = spawn(process.execPath, [cliEntry, '--config', configPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cliEnv(configPath),
  });
  children.add(child);
  return waitForExit(child, timeoutMs);
}

function cliEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    MARIFOLD_SERVICE_STATE_DIR: serviceStateDir(configPath),
  };
}

function serviceStateDir(configPath: string): string {
  return path.join(path.dirname(configPath), 'service-state');
}

async function waitForFileOutput(filePath: string, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) output = fs.readFileSync(filePath, 'utf8');
    if (pattern.test(output)) return output;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${filePath}. Output:\n${output}`);
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
