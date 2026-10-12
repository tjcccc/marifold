import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

export interface DockerResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface DockerRunOptions {
  input?: Buffer | string | Readable;
  /** Collect stdout into this many bytes at most; the rest is counted and dropped. */
  maxOutput?: number;
  /** Stream stdout here instead of collecting it. */
  stdout?: NodeJS.WritableStream;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Services started by launchd often lack the user's shell PATH. */
const CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  path.join(os.homedir(), '.orbstack', 'bin', 'docker'),
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/bin/docker',
];

export function findDocker(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'docker');
    if (isExecutable(candidate)) { return candidate; }
  }
  return CANDIDATES.find(isExecutable);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Runs the docker CLI with an argument array; nothing passes through a host shell. */
export class DockerCli {
  constructor(readonly binary: string) {}

  run(args: string[], options: DockerRunOptions = {}): Promise<DockerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let collected = 0;
      let stderr = '';
      let settled = false;
      const limit = options.maxOutput ?? 16 * 1024 * 1024;
      const finish = (error?: Error, code = 1) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) { reject(error); } else { resolve({ code, stdout: Buffer.concat(chunks), stderr }); }
      };
      const abort = () => {
        child.kill('SIGKILL');
        finish(new Error('Cancelled.'));
      };
      const timer = options.timeoutMs
        ? setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`docker ${args[0]} timed out.`)); }, options.timeoutMs)
        : undefined;
      if (options.signal?.aborted) { return abort(); }
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.stdout) {
        child.stdout.pipe(options.stdout);
      } else {
        child.stdout.on('data', (chunk: Buffer) => {
          if (collected < limit) { chunks.push(chunk.subarray(0, limit - collected)); }
          collected += chunk.length;
        });
      }
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) { stderr += chunk.toString('utf8'); } });
      child.on('error', error => finish(error));
      child.on('close', code => finish(undefined, code ?? 1));
      child.stdin.on('error', () => undefined);
      const input = options.input;
      if (input === undefined) {
        child.stdin.end();
      } else if (typeof input === 'string' || Buffer.isBuffer(input)) {
        child.stdin.end(input);
      } else {
        input.on('error', error => { child.kill('SIGKILL'); finish(error); });
        input.pipe(child.stdin);
      }
    });
  }

  /** Run and throw with docker's own message on a non-zero exit. */
  async check(args: string[], options: DockerRunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0) { throw new Error(result.stderr.trim() || `docker ${args[0]} exited with ${result.code}.`); }
    return result.stdout.toString('utf8').trim();
  }
}
