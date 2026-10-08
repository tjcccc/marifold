import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceExecution, writePrivateJson, type DeviceJob } from '../src/agent/DeviceExecution';
import { ShellExecTool } from '../src/agent/tools/ShellExecTool';
import { ShellJobStatusTool } from '../src/agent/tools/ShellJobStatusTool';
import { WorkspaceExecutor } from '../src/workspace/WorkspaceExecutor';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import type { ToolExecutionResult } from '../src/agent/ToolRegistry';

// Detached workers execute shipped JavaScript, including in this integration test.
// Run the core build first (as in the full repository gate).
const BuiltDeviceExecution: typeof DeviceExecution = require('../dist/agent/DeviceExecution').DeviceExecution;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-device-execution-'));
  directories.push(directory);
  return { directory, device: new BuiltDeviceExecution(path.join(directory, 'config.toml')) };
}
async function finished(device: DeviceExecution, id: string): Promise<DeviceJob> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = device.status(id);
    if (!['running', 'queued'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Job did not finish.');
}
const context = { cwd: os.tmpdir(), outputLimit: 1000 };
describe('device-local full execution', () => {
  it('defaults to scoped, rejects invalid access, and requires nonpersistent approval even with full mode', () => {
    const { device } = fixture();
    const tool = new ShellExecTool(device);
    expect(tool.assessRisk({ command: 'true', access: 'full' }, context).blocked).toBe(true);
    expect(tool.assessRisk({ command: 'true', access: 'anything' }, context).blocked).toBe(true);
    device.setMode('full');
    expect(tool.assessRisk({ command: 'true', access: 'full' }, context)).toMatchObject({ blocked: false, escalate: true, persistable: false });
    // Full opt-in never turns default shell calls into unrestricted commands.
    expect(tool.assessRisk({ command: 'true' }, context).blocked).toBe(true);
  });

  it('rechecks local opt-in at execution and refuses cancelled calls before spawning', async () => {
    const { device } = fixture();
    device.setMode('full');
    const tool = new ShellExecTool(device);
    tool.assessRisk({ command: 'true', access: 'full' }, context);
    device.setMode('scoped');
    await expect(tool.execute({ command: 'true', access: 'full' }, context)).rejects.toThrow('disabled');
    device.setMode('full');
    await expect(tool.execute({ command: 'true', access: 'full' }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(device.recent()).toEqual([]);
  });

  it('runs with account permissions and persists completion after caller cancellation and controller recreation', async () => {
    const { directory, device } = fixture();
    device.setMode('full');
    const controller = new AbortController();
    const tool = new ShellExecTool(device);
    const result = await tool.execute({ command: 'sleep 0.2; printf durable > completed.txt; printf complete', access: 'full' },
      { ...context, cwd: directory, signal: controller.signal });
    const job = JSON.parse(result.content) as DeviceJob;
    controller.abort();
    const recovered = new BuiltDeviceExecution(path.join(directory, 'config.toml'));
    expect(await finished(recovered, job.id)).toMatchObject({ state: 'succeeded', output: 'complete', exitCode: 0 });
    expect(fs.readFileSync(path.join(directory, 'completed.txt'), 'utf8')).toBe('durable');
    expect(fs.existsSync(path.join(device.directory, job.id, 'request.json'))).toBe(false);
    device.setMode('scoped');
    const status = await new ShellJobStatusTool(recovered).execute({ job_id: job.id }, context);
    expect(JSON.parse(status.content)).toMatchObject({ mode: 'scoped', job: { state: 'succeeded' } });
  });

  it('reports failure and bounded output without retrying the command', async () => {
    const { directory, device } = fixture();
    device.setMode('full');
    const job = await device.start('printf x >> count; printf failure >&2; exit 7', directory, process.env);
    expect(await finished(device, job.id)).toMatchObject({ state: 'failed', output: 'failure', exitCode: 7 });
    device.status(job.id);
    expect(fs.readFileSync(path.join(directory, 'count'), 'utf8')).toBe('x');
    await expect(new ShellJobStatusTool(device).execute({ job_id: '../../policy.json' }, context)).rejects.toThrow('Invalid');
  });

  it('fails closed for malformed or symlinked policy and preserves config isolation', () => {
    const { directory, device } = fixture();
    device.setMode('full');
    expect(new DeviceExecution(path.join(directory, 'other.toml')).mode()).toBe('scoped');
    fs.writeFileSync(path.join(device.directory, 'policy.json'), 'bad');
    expect(device.mode()).toBe('scoped');
    fs.unlinkSync(path.join(device.directory, 'policy.json'));
    const outside = path.join(directory, 'outside.json');
    fs.writeFileSync(outside, '{"mode":"full"}', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(device.directory, 'policy.json'));
    expect(device.mode()).toBe('scoped');
  });

  it('drops job records older than a week when starting a job', async () => {
    const { directory, device } = fixture();
    device.setMode('full');
    const fresh = await device.start('printf fresh', directory, process.env);
    await finished(device, fresh.id);
    const oldId = '00000000-0000-4000-8000-000000000000';
    fs.mkdirSync(path.join(device.directory, oldId), { mode: 0o700 });
    writePrivateJson(path.join(device.directory, oldId, 'result.json'), {
      id: oldId, state: 'succeeded', createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    });
    expect(device.recent().map(job => job.id)).toContain(oldId);
    const next = await device.start('printf next', directory, process.env);
    await finished(device, next.id);
    expect(device.recent().map(job => job.id).sort()).toEqual([fresh.id, next.id].sort());
  });

  it('stops a job and its background children at the time limit and reports it', async () => {
    const { directory, device } = fixture();
    device.setMode('full');
    const started = Date.now();
    const job = await device.start('sleep 30 & sleep 30', directory, { ...process.env, MARIFOLD_TEST_DEVICE_JOB_LIMIT_MS: '1000' });
    const result = await finished(device, job.id);
    expect(result.state).toBe('failed');
    expect(result.output).toContain('exceeded the 1-second limit and was stopped');
    expect(Date.now() - started).toBeLessThan(9000);
  });

  it('remote execution consumes one grant, enforces guest policy, and recovers jobs across executor restart', async () => {
    const { directory, device } = fixture();
    const remote = { workspaceId: 'workspace', senderDeviceId: 'host', hostDeviceId: 'host' };
    const make = () => new WorkspaceExecutor(() => resolveAgentConfig({ approval: { shell: 'allow' } }), path.join(directory, 'runs'), [], undefined, device);
    let executor = make();
    try {
      await executor.handle('executor.prepare', { runId: 'first', cwd: directory }, remote);
      const call = { runId: 'first', tool: 'shell_exec', input: { access: 'full', command: 'sleep 0.2; printf remote' } };
      expect(await executor.handle('executor.assess', call, remote)).toMatchObject({ blocked: true });
      device.setMode('full');
      const grant = await executor.handle('executor.assess', call, remote) as { grant: string };
      expect(grant).toMatchObject({ blocked: false, escalate: true, persistable: false });
      await expect(executor.handle('executor.execute', { ...call, grant: 'fake' }, remote)).rejects.toThrow('invalid');
      const result = await executor.handle('executor.execute', { ...call, grant: grant.grant }, remote) as ToolExecutionResult;
      await expect(executor.handle('executor.execute', { ...call, grant: grant.grant }, remote)).rejects.toThrow('invalid');
      const job = JSON.parse(result.content) as DeviceJob;
      executor.close();
      executor = make();
      expect(await finished(device, job.id)).toMatchObject({ state: 'succeeded', output: 'remote' });
      await executor.handle('executor.prepare', { runId: 'second', cwd: directory }, remote);
      const read = { runId: 'second', tool: 'shell_job_status', input: { job_id: job.id } };
      const readGrant = await executor.handle('executor.assess', read, remote) as { grant: string };
      const status = await executor.handle('executor.execute', { ...read, grant: readGrant.grant }, remote) as ToolExecutionResult;
      expect(JSON.parse(status.content).job.state).toBe('succeeded');
      // Another workspace this device joined cannot list or read the job; the
      // device's own runs can.
      const other = { ...remote, workspaceId: 'other-workspace' };
      await executor.handle('executor.prepare', { runId: 'third', cwd: directory }, other);
      const statusAs = async (input: Record<string, string>) => {
        const call = { runId: 'third', tool: 'shell_job_status', input };
        const grant = await executor.handle('executor.assess', call, other) as { grant: string };
        return executor.handle('executor.execute', { ...call, grant: grant.grant }, other) as Promise<ToolExecutionResult>;
      };
      expect(JSON.parse((await statusAs({})).content).jobs).toEqual([]);
      await expect(statusAs({ job_id: job.id })).rejects.toThrow('Unknown shell job ID');
      const local = await new ShellJobStatusTool(device).execute({}, { cwd: directory });
      expect(JSON.parse(local.content).jobs.map((item: DeviceJob) => item.id)).toContain(job.id);
      const revoked = await executor.handle('executor.assess', { ...call, runId: 'second' }, remote) as { grant: string };
      device.setMode('scoped');
      await expect(executor.handle('executor.execute', { ...call, runId: 'second', grant: revoked.grant }, remote)).rejects.toThrow('invalid');
    } finally { executor.close(); }
  });
});
