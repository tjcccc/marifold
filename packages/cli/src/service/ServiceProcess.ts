import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { marifoldHome } from '@marifold/core';

export type ServiceProcessMode = 'foreground' | 'daemon';
export type ServiceProcessStatus = 'starting' | 'running';

export interface ServiceProcessState {
  version: 1;
  instanceId: string;
  pid: number;
  mode: ServiceProcessMode;
  status: ServiceProcessStatus;
  startedAt: string;
  configPath: string;
  address?: string;
}

export interface ServiceProcessPaths {
  dir: string;
  state: string;
  log: string;
  lock: string;
}

const STATE_DIR_ENV = 'MARIFOLD_SERVICE_STATE_DIR';
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 1_000;
const LOCK_RETRY_MS = 10;
const LOG_READ_BYTES = 256 * 1024;

export function serviceProcessPaths(): ServiceProcessPaths {
  const dir = process.env[STATE_DIR_ENV] ?? path.join(marifoldHome(), 'service');
  return {
    dir,
    state: path.join(dir, 'state.json'),
    log: path.join(dir, 'service.log'),
    lock: path.join(dir, 'state.lock'),
  };
}

export function ensureServiceProcessDir(paths = serviceProcessPaths()): void {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
}

export function claimServiceProcess(
  mode: ServiceProcessMode,
  configPath: string,
  paths = serviceProcessPaths(),
): ServiceProcessState {
  return withStateLock(paths, () => {
    const existing = readStateFile(paths.state);
    if (existing && isProcessRunning(existing.pid)) {
      throw new Error(`Marifold service is already running (PID ${existing.pid}, ${existing.mode}).`);
    }
    if (fs.existsSync(paths.state)) fs.unlinkSync(paths.state);

    const state: ServiceProcessState = {
      version: 1,
      instanceId: crypto.randomUUID(),
      pid: process.pid,
      mode,
      status: 'starting',
      startedAt: new Date().toISOString(),
      configPath,
    };
    writeStateFile(paths.state, state);
    return state;
  });
}

export function markServiceProcessRunning(
  owner: ServiceProcessState,
  address: string,
  paths = serviceProcessPaths(),
): ServiceProcessState {
  return withStateLock(paths, () => {
    const current = readStateFile(paths.state);
    if (!current || current.instanceId !== owner.instanceId) {
      throw new Error('Marifold service ownership changed while it was starting.');
    }
    const running: ServiceProcessState = { ...current, status: 'running', address };
    writeStateFile(paths.state, running);
    return running;
  });
}

export function releaseServiceProcess(
  owner: ServiceProcessState,
  paths = serviceProcessPaths(),
): void {
  withStateLock(paths, () => {
    const current = readStateFile(paths.state);
    if (current?.instanceId === owner.instanceId) fs.unlinkSync(paths.state);
  });
}

export function getActiveServiceProcess(paths = serviceProcessPaths()): ServiceProcessState | undefined {
  return withStateLock(paths, () => {
    const state = readStateFile(paths.state);
    if (state && isProcessRunning(state.pid)) return state;
    if (fs.existsSync(paths.state)) fs.unlinkSync(paths.state);
    return undefined;
  });
}

export async function stopActiveServiceProcess(
  timeoutMs = 7_000,
  paths = serviceProcessPaths(),
): Promise<ServiceProcessState | undefined> {
  const state = getActiveServiceProcess(paths);
  if (!state) return undefined;

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (!isNoSuchProcessError(error)) throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(state.pid)) {
      getActiveServiceProcess(paths);
      return state;
    }
    await delay(50);
  }
  throw new Error(`Marifold service (PID ${state.pid}) did not stop within ${timeoutMs}ms.`);
}

export function readRecentServiceLog(
  lineCount = 100,
  paths = serviceProcessPaths(),
): string | undefined {
  if (!fs.existsSync(paths.log)) return undefined;
  const stat = fs.statSync(paths.log);
  if (stat.size === 0) return '';

  const bytes = Math.min(stat.size, LOG_READ_BYTES);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(paths.log, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString('utf8');
  if (bytes < stat.size) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  return text.trimEnd().split(/\r?\n/).slice(-lineCount).join('\n');
}

function withStateLock<T>(paths: ServiceProcessPaths, action: () => T): T {
  ensureServiceProcessDir(paths);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(paths.lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const stat = safeStat(paths.lock);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        try {
          fs.rmdirSync(paths.lock);
        } catch {
          // Another process recovered or acquired the lock first.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Marifold service state lock.');
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    try {
      fs.rmdirSync(paths.lock);
    } catch {
      // A later state operation can recover an abandoned empty lock directory.
    }
  }
}

function readStateFile(filePath: string): ServiceProcessState | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isServiceProcessState(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function writeStateFile(filePath: string, state: ServiceProcessState): void {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function isServiceProcessState(value: unknown): value is ServiceProcessState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.version === 1
    && typeof state.instanceId === 'string'
    && Number.isInteger(state.pid)
    && Number(state.pid) > 0
    && (state.mode === 'foreground' || state.mode === 'daemon')
    && (state.status === 'starting' || state.status === 'running')
    && typeof state.startedAt === 'string'
    && typeof state.configPath === 'string'
    && (state.address === undefined || typeof state.address === 'string');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNoSuchProcessError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ESRCH';
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EPERM';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
