import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SudoCredentials } from './SudoCredentials';

export type DeviceExecutionMode = 'scoped' | 'full';
const JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
export interface DeviceJob {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  commandHash?: string;
  finishedAt?: string;
  pid?: number;
  output?: string;
  exitCode?: number | null;
  /** Workspace that started the job through its bridge; absent for local runs. */
  scope?: string;
}

/** Local-only policy: intentionally absent from config APIs and workspace RPC. */
export class DeviceExecution {
  readonly sudo = new SudoCredentials();
  readonly directory: string;
  constructor(configPath: string) {
    const resolved = path.resolve(configPath);
    this.directory = path.join(path.dirname(resolved), 'workspaces', 'device-execution',
      createHash('sha256').update(resolved).digest('hex').slice(0, 16));
  }

  mode(): DeviceExecutionMode {
    try {
      this.checkDirectory();
      const value = readPrivateJson(path.join(this.directory, 'policy.json'));
      return value.mode === 'full' ? 'full' : 'scoped';
    } catch { return 'scoped'; }
  }

  setMode(mode: DeviceExecutionMode): void {
    if (mode !== 'scoped' && mode !== 'full') { throw new Error('Expected scoped or full execution mode.'); }
    this.prepare();
    writePrivateJson(path.join(this.directory, 'policy.json'), { mode });
  }

  async start(command: string, cwd: string, environment: NodeJS.ProcessEnv, password?: Buffer, scope?: string): Promise<DeviceJob> {
    if (this.mode() !== 'full') { throw new Error('Full access is disabled on this device. Enable it locally with marifold execution mode full.'); }
    if (process.platform !== 'darwin' && process.platform !== 'linux') { throw new Error('Full access currently supports macOS and Linux.'); }
    const worker = path.join(__dirname, 'DeviceExecutionWorker.js');
    if (!fs.existsSync(worker)) { throw new Error('Device worker is missing. Build or reinstall Marifold.'); }
    this.prepare();
    this.prune();
    if (this.recent().filter(job => job.state === 'queued' || job.state === 'running').length >= 8) {
      throw new Error('Device already has eight active full-access jobs. Inspect their status before starting more.');
    }
    const id = randomUUID();
    const directory = path.join(this.directory, id);
    fs.mkdirSync(directory, { mode: 0o700 });
    const job: DeviceJob = { id, state: 'queued', createdAt: new Date().toISOString(),
      commandHash: createHash('sha256').update(command).digest('hex'), ...(scope ? { scope } : {}) };
    writePrivateJson(path.join(directory, 'result.json'), job);
    // Environment remains in memory; credentials are never serialized into the job.
    writePrivateJson(path.join(directory, 'request.json'), { command, cwd, sudo: password !== undefined });
    const child = spawn(process.execPath, [worker, directory], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: environment,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => {
        writePrivateJson(path.join(directory, 'result.json'), { ...job, state: 'failed', output: error.message, finishedAt: new Date().toISOString() });
        fs.rmSync(path.join(directory, 'request.json'), { force: true });
        reject(error);
      });
    });
    // Only an anonymous pipe carries the password, never argv, env, or a file.
    child.stdin?.on('error', () => { /* Worker startup failure is reported by job status. */ });
    await new Promise<void>(resolve => child.stdin!.end(password, resolve));
    child.unref();
    return job;
  }

  /** A scoped caller (a workspace's bridged request) sees only the jobs that
   * workspace started; the device's own runs see every job. */
  status(id: string, scope?: string): DeviceJob {
    if (!/^[a-f0-9-]{36}$/.test(id)) { throw new Error('Invalid shell job ID.'); }
    this.checkDirectory();
    const directory = path.join(this.directory, id);
    if (!fs.existsSync(directory)) { throw new Error('Unknown shell job ID.'); }
    assertPrivateDirectory(directory);
    const job = readPrivateJson(path.join(directory, 'result.json')) as unknown as DeviceJob;
    if (scope !== undefined && job.scope !== scope) { throw new Error('Unknown shell job ID.'); }
    if (job.state === 'running' && Date.now() - Date.parse(job.createdAt) > 11 * 60_000) {
      return { ...job, state: 'unknown', output: 'Job exceeded its reporting deadline. Inspect the device before retrying.' };
    }
    if (job.state === 'running' && job.pid) {
      try { process.kill(job.pid, 0); } catch {
        return { ...job, state: 'unknown', output: 'Worker is unavailable; outcome is unknown. Inspect the device before retrying.' };
      }
    }
    if (job.state === 'queued' && Date.now() - Date.parse(job.createdAt) > 30_000) {
      return { ...job, state: 'unknown', output: 'Worker did not report startup. Inspect the device before retrying.' };
    }
    return job;
  }

  recent(scope?: string): DeviceJob[] {
    if (!fs.existsSync(this.directory)) { return []; }
    this.checkDirectory();
    return fs.readdirSync(this.directory).filter(id => /^[a-f0-9-]{36}$/.test(id))
      .map(id => this.status(id)).filter(job => scope === undefined || job.scope === scope).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
      .map(({ output: _output, ...job }) => job);
  }

  /** Drop job records older than a week. Jobs run at most ten minutes, and
   * every status read scans this directory. */
  private prune(now = Date.now()): void {
    for (const id of fs.readdirSync(this.directory).filter(id => /^[a-f0-9-]{36}$/.test(id))) {
      try {
        const job = readPrivateJson(path.join(this.directory, id, 'result.json'));
        if (now - Date.parse(String(job.createdAt)) > JOB_RETENTION_MS) {
          fs.rmSync(path.join(this.directory, id), { recursive: true, force: true });
        }
      } catch { /* Unreadable records stay for inspection. */ }
    }
  }

  private checkDirectory(): void {
    assertPrivateDirectory(path.dirname(path.dirname(this.directory)));
    assertPrivateDirectory(path.dirname(this.directory));
    assertPrivateDirectory(this.directory);
  }
  private prepare(): void {
    // Do not follow a replaced policy directory out of the sandbox-denied tree.
    for (const directory of [path.dirname(path.dirname(this.directory)), path.dirname(this.directory), this.directory]) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
      }
      assertPrivateDirectory(directory);
    }
  }
}

export function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) { throw new Error('Unsafe device execution directory.'); }
}

export function readPrivateJson(file: string): Record<string, unknown> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) { throw new Error('Unsafe device execution file.'); }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function writePrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
