import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimServiceProcess,
  ensureServiceProcessDir,
  getActiveServiceProcess,
  markServiceProcessRunning,
  readRecentServiceLog,
  releaseServiceProcess,
  ServiceProcessPaths,
} from '../src/service/ServiceProcess';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('service process state', () => {
  it('claims one owner, records readiness, and releases it', () => {
    const paths = fixturePaths();
    const owner = claimServiceProcess('foreground', '/tmp/config.toml', paths, {
      host: '0.0.0.0',
      port: '32140',
      cwd: '/tmp/workspace',
      log: true,
      corsOrigins: ['https://example.test'],
      tokenSource: 'raw',
    });

    expect(getActiveServiceProcess(paths)).toMatchObject({
      pid: process.pid,
      mode: 'foreground',
      status: 'starting',
      launch: {
        host: '0.0.0.0',
        port: '32140',
        cwd: '/tmp/workspace',
        log: true,
        corsOrigins: ['https://example.test'],
        tokenSource: 'raw',
      },
    });
    expect(() => claimServiceProcess('daemon', '/tmp/config.toml', paths)).toThrow('already running');

    markServiceProcessRunning(owner, {
      address: 'http://127.0.0.1:32140',
      startup: {
        telegramProfile: 'messenger',
        webDir: '/tmp/web',
        authRequired: true,
        corsOrigins: ['https://example.test'],
      },
    }, paths);
    expect(getActiveServiceProcess(paths)).toMatchObject({
      status: 'running',
      address: 'http://127.0.0.1:32140',
      startup: {
        telegramProfile: 'messenger',
        webDir: '/tmp/web',
        authRequired: true,
        corsOrigins: ['https://example.test'],
      },
    });

    releaseServiceProcess(owner, paths);
    expect(getActiveServiceProcess(paths)).toBeUndefined();
  });

  it('removes stale state', () => {
    const paths = fixturePaths();
    ensureServiceProcessDir(paths);
    fs.writeFileSync(paths.state, JSON.stringify({
      version: 1,
      instanceId: 'stale',
      pid: 2_147_483_647,
      mode: 'daemon',
      status: 'running',
      startedAt: new Date(0).toISOString(),
      configPath: '/tmp/config.toml',
    }));

    expect(getActiveServiceProcess(paths)).toBeUndefined();
    expect(fs.existsSync(paths.state)).toBe(false);
  });

  it('returns a bounded log tail', () => {
    const paths = fixturePaths();
    ensureServiceProcessDir(paths);
    fs.writeFileSync(paths.log, Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join('\n'));

    const logs = readRecentServiceLog(100, paths);
    expect(logs?.split('\n')).toHaveLength(100);
    expect(logs).toMatch(/^line 21\n/);
    expect(logs).toMatch(/line 120$/);
  });
});

function fixturePaths(): ServiceProcessPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-service-process-'));
  tempDirs.push(dir);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    log: path.join(dir, 'service.log'),
    lock: path.join(dir, 'state.lock'),
  };
}
