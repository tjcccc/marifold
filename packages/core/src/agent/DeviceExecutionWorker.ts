import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { assertPrivateDirectory, readPrivateJson, writePrivateJson, type DeviceJob } from './DeviceExecution';

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
    const child = spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let truncated = false;
    const append = (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 128_000) { output = output.slice(-128_000); truncated = true; }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // No bridge/run signal reaches this worker. Bound abandoned jobs locally.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    }, 10 * 60_000);
    const result = await new Promise<{ code: number | null; error?: string }>(resolve => {
      child.once('error', error => resolve({ code: null, error: error.message }));
      child.once('close', code => resolve({ code }));
    });
    clearTimeout(timer);
    writePrivateJson(file, { ...job, state: result.code === 0 && !timedOut ? 'succeeded' : 'failed',
      finishedAt: new Date().toISOString(), exitCode: result.code,
      output: `${truncated ? '[Earlier output truncated]\n' : ''}${output}${result.error ?? ''}${timedOut ? '\nJob exceeded the 10-minute limit; process group killed. Check device state before retrying.' : ''}` });
  } catch (error) {
    fs.rmSync(path.join(directory, 'request.json'), { force: true });
    writePrivateJson(file, { ...job, state: 'failed', finishedAt: new Date().toISOString(), output: String(error) });
  }
}

if (require.main === module) void main(process.argv[2]!).catch(() => { process.exitCode = 1; });
