import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { assertPrivateDirectory, readPrivateJson, writePrivateJson, type DeviceJob } from './DeviceExecution';
import { validateSudoPassword } from './SudoCredentials';

// A separate process owns completion. Bridge disconnects and run cancellation
// must not kill a command halfway through restoring a network service.
async function main(directory: string): Promise<void> {
  assertPrivateDirectory(directory);
  const file = path.join(directory, 'result.json');
  const job = readPrivateJson(file) as unknown as DeviceJob;
  try {
    assertPrivateDirectory(path.dirname(directory));
    if (readPrivateJson(path.join(path.dirname(directory), 'policy.json')).mode !== 'full')
      throw new Error('Full access was disabled before execution started.');
    const request = readPrivateJson(path.join(directory, 'request.json'));
    fs.unlinkSync(path.join(directory, 'request.json'));
    if (typeof request.command !== 'string' || typeof request.cwd !== 'string') throw new Error('Invalid job request.');
    writePrivateJson(file, { ...job, state: 'running', pid: process.pid });
    let password: Buffer | undefined;
    if (request.sudo === true) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 128) { for (const part of chunks) part.fill(0); chunk.fill(0); throw new Error('Invalid sudo credential size.'); }
        chunks.push(chunk);
      }
      password = Buffer.concat(chunks);
      for (const part of chunks) part.fill(0);
      try { validateSudoPassword(password); } catch (error) { password.fill(0); throw error; }
    }
    // The limit is overridable only so tests can exercise it quickly.
    const limitMs = Number(process.env.MARIFOLD_TEST_DEVICE_JOB_LIMIT_MS) || JOB_LIMIT_MS;
    // This unprivileged worker cannot signal a root command, and sudo does not
    // relay signals to it. Where coreutils `timeout` exists (Linux), it enforces
    // the limit as root and stops the command's whole process group.
    const rootTimeout = password && fs.existsSync('/usr/bin/timeout')
      ? ['/usr/bin/timeout', '-k', '5', String(Math.ceil(limitMs / 1000))] : [];
    // -k ignores cached authentication for this invocation. Root command stdin
    // is /dev/null, even when a NOPASSWD rule means sudo does not consume input.
    const child = password
      ? spawn('/usr/bin/sudo', ['-k', '-S', '-p', '', '--', ...rootTimeout, '/bin/sh', '-c', 'exec /bin/sh -c "$1" </dev/null', 'marifold', request.command], { cwd: request.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      : spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (password) {
      const bytes = password;
      const line = Buffer.concat([bytes, Buffer.from('\n')]);
      child.stdin!.on('error', () => { line.fill(0); bytes.fill(0); });
      child.stdin!.end(line, () => { line.fill(0); bytes.fill(0); });
      password = undefined;
    }
    let output = '';
    let truncated = false;
    const append = (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 128_000) { output = output.slice(-128_000); truncated = true; }
    };
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    // No bridge/run signal reaches this worker. Bound abandoned jobs locally:
    // ask the process group to stop, then kill it, then stop waiting for output
    // pipes that a surviving privileged process may still hold.
    let timedOut = false;
    let abandoned = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } }
    };
    let settle!: (result: { code: number | null; error?: string }) => void;
    const finished = new Promise<{ code: number | null; error?: string }>(resolve => { settle = resolve; });
    child.once('error', error => settle({ code: null, error: error.message }));
    child.once('close', code => settle({ code }));
    const timers = [setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => signalGroup('SIGKILL'), 5000));
      timers.push(setTimeout(() => { abandoned = true; settle({ code: null }); }, 10_000));
    }, limitMs + (rootTimeout.length ? 10_000 : 0))];
    const result = await finished;
    for (const timer of timers) clearTimeout(timer);
    child.stdout!.destroy();
    child.stderr!.destroy();
    // GNU timeout reports 124 when it stopped the command, 137 when it had to kill it.
    if (rootTimeout.length && (result.code === 124 || result.code === 137)) timedOut = true;
    const limitNote = abandoned
      ? `\nJob exceeded the ${formatLimit(limitMs)} limit. Its processes were signalled, but a privileged command may still be running. Check device state before retrying.`
      : timedOut ? `\nJob exceeded the ${formatLimit(limitMs)} limit and was stopped. Check device state before retrying.` : '';
    writePrivateJson(file, { ...job, state: result.code === 0 && !timedOut ? 'succeeded' : 'failed',
      finishedAt: new Date().toISOString(), exitCode: result.code,
      output: `${truncated ? '[Earlier output truncated]\n' : ''}${output}${result.error ?? ''}${limitNote}` });
  } catch (error) {
    fs.rmSync(path.join(directory, 'request.json'), { force: true });
    writePrivateJson(file, { ...job, state: 'failed', finishedAt: new Date().toISOString(), output: String(error) });
  }
}

const JOB_LIMIT_MS = 10 * 60_000;

function formatLimit(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}-minute` : `${Math.round(ms / 1000)}-second`;
}

if (require.main === module) void main(process.argv[2]!).catch(() => { process.exitCode = 1; });
