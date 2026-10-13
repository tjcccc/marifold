import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentComputer } from './AgentComputer';

export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
export const MAX_TRANSFER_FILES = 20_000;

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/**
 * Run a shell command as the profile's account. The command runs under
 * `timeout` in its own process group; cancelling kills that group inside the
 * container, because killing the local `docker exec` client alone would leave
 * the command running.
 */
export async function execInComputer(
  computer: AgentComputer,
  profile: string,
  command: string,
  options: { timeoutSeconds: number; signal?: AbortSignal; maxOutput: number },
): Promise<ExecResult> {
  const { container, user, home } = await computer.ready(profile);
  const id = randomBytes(8).toString('hex');
  const wrapper = 'mkdir -p /tmp/.marifold-exec && echo $$ > "/tmp/.marifold-exec/$1" && exec 2>&1 && exec timeout -k 5 "$2" bash -lc "$3"';
  // bash, not sh: dash's kill rejects "--" before a negative process-group ID.
  const stop = () => void computer.cli().run(['exec', '-u', 'root', container, 'bash', '-c',
    'p=$(cat "/tmp/.marifold-exec/$1" 2>/dev/null) || exit 0; kill -TERM -- "-$p" 2>/dev/null; sleep 2; kill -KILL -- "-$p" 2>/dev/null; rm -f "/tmp/.marifold-exec/$1"; true', '_', id,
  ], { timeoutMs: 30_000 }).catch(() => undefined);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await computer.cli().run(
      ['exec', '-i', '-u', user, '-w', home, container, 'bash', '-c', wrapper, '_', id, String(options.timeoutSeconds), command],
      { maxOutput: options.maxOutput, signal: options.signal, timeoutMs: (options.timeoutSeconds + 30) * 1000 },
    );
    void computer.cli().run(['exec', '-u', 'root', container, 'rm', '-f', `/tmp/.marifold-exec/${id}`]).catch(() => undefined);
    return { exitCode: result.code, output: result.stdout.toString('utf8'), timedOut: result.code === 124 };
  } finally {
    options.signal?.removeEventListener('abort', stop);
  }
}

/** Write text to a path inside the computer (relative paths start at the account's home). */
export async function writeComputerFile(computer: AgentComputer, profile: string, target: string, content: string): Promise<void> {
  const { container, user, home } = await computer.ready(profile);
  await computer.cli().check(
    ['exec', '-i', '-u', user, '-w', home, container, 'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', '_', target],
    { input: content, timeoutMs: 120_000 },
  );
}

/** Copy a file or folder from this device into the computer. The caller has
 * already approved reading `source`; `refuse` vets every entry of a folder. */
export async function putIntoComputer(
  computer: AgentComputer,
  profile: string,
  source: string,
  destination: string,
  refuse: (entry: string) => string | undefined,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; destination: string }> {
  const stat = fs.lstatSync(source);
  const { container, user, home } = await computer.ready(profile);
  if (stat.isFile()) {
    if (stat.size > MAX_TRANSFER_BYTES) { throw new Error(`${source} is larger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB.`); }
    const target = destination.endsWith('/') ? `${destination}${path.basename(source)}` : destination;
    await computer.cli().check(
      ['exec', '-i', '-u', user, '-w', home, container, 'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', '_', target],
      { input: fs.createReadStream(source), timeoutMs: 30 * 60_000, signal },
    );
    return { files: 1, bytes: stat.size, destination: target };
  }
  if (!stat.isDirectory()) { throw new Error(`${source} is not a regular file or folder.`); }
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const reason = refuse(full);
      if (reason) { throw new Error(`${full}: ${reason}`); }
      if (entry.isDirectory()) { walk(full); continue; }
      files++;
      if (entry.isFile()) { bytes += fs.statSync(full).size; }
      if (files > MAX_TRANSFER_FILES || bytes > MAX_TRANSFER_BYTES) {
        throw new Error(`${source} has more than ${MAX_TRANSFER_FILES} files or ${MAX_TRANSFER_BYTES / 1024 / 1024} MB.`);
      }
    }
  };
  walk(source);
  // tar keeps symlinks as links; it never follows them out of the folder.
  const tar = spawn('tar', ['-C', path.dirname(source), '-cf', '-', path.basename(source)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const tarFailed = new Promise<never>((_, reject) => tar.on('close', code => { if (code) { reject(new Error(`Packing ${source} failed.`)); } }));
  await Promise.race([
    computer.cli().check(
      ['exec', '-i', '-u', user, '-w', home, container, 'sh', '-c', 'mkdir -p -- "$1" && tar -xf - --no-same-owner --warning=no-unknown-keyword -C "$1"', '_', destination],
      { input: tar.stdout, timeoutMs: 30 * 60_000, signal },
    ),
    tarFailed,
  ]);
  return { files, bytes, destination: path.posix.join(destination, path.basename(source)) };
}

/** Copy one file out of the computer into `outputDir`, where it becomes a run artifact. */
export async function getFromComputer(
  computer: AgentComputer,
  profile: string,
  source: string,
  outputDir: string,
  signal?: AbortSignal,
): Promise<{ file: string; bytes: number }> {
  const { container, user, home } = await computer.ready(profile);
  const size = Number(await computer.cli().check(
    ['exec', '-u', user, '-w', home, container, 'sh', '-c', '[ -f "$1" ] || { echo "$1 is not a regular file in the computer" >&2; exit 2; }; stat -c %s -- "$1"', '_', source],
    { timeoutMs: 60_000 },
  ));
  if (!Number.isSafeInteger(size) || size > MAX_TRANSFER_BYTES) { throw new Error(`${source} is larger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB.`); }
  const file = uniquePath(outputDir, path.posix.basename(source).replace(/[^\w.@+-]/g, '_') || 'file');
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  try {
    const result = await computer.cli().run(['exec', '-u', user, '-w', home, container, 'cat', '--', source], { stdout: out, timeoutMs: 30 * 60_000, signal });
    await new Promise<void>(resolve => (out.writableFinished ? resolve() : out.once('finish', () => resolve())));
    if (result.code !== 0) { throw new Error(result.stderr.trim() || `Could not read ${source}.`); }
  } catch (error) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw error;
  }
  return { file, bytes: fs.statSync(file).size };
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) { return candidate; }
  }
}
