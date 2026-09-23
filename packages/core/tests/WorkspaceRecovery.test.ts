import * as fs from 'node:fs';
import sharp from 'sharp';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/workspace/WorkspaceStore';
import { WorkspaceExecutor } from '../src/workspace/WorkspaceExecutor';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { listRunArtifacts } from '../src/agent/RunArtifacts';
import { runScopedProcess } from '../src/agent/ScopedProcess';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import type { ToolExecutionResult, ToolRiskAssessment } from '../src/agent/ToolRegistry';
import { RunRegistry, type RunRecord } from '../src/runs/RunRegistry';

const dirs: string[] = [];
const stores: WorkspaceStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function directory() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-recovery-'));
  dirs.push(d);
  return d;
}
function store(config = path.join(directory(), 'config.toml')) {
  const s = new WorkspaceStore(config);
  stores.push(s);
  return s;
}
describe('workspace recovery and device boundaries', () => {
  it('returns portable inspected images and trusts only attachment tools', async () => {
    const d = directory();
    const executor = new WorkspaceExecutor(() => resolveAgentConfig({ approval: { read: 'deny' } }), path.join(d, 'runs'));
    const context = { workspaceId: 'workspace', senderDeviceId: 'host', hostDeviceId: 'host' };
    const data = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()).toString('base64');
    try {
      const workspace = await executor.handle('executor.prepare', {
        runId: 'image_run', images: [{ data, mediaType: 'image/png' }, { url: 'https://example.com/image.png', mediaType: 'image/png' }],
      }, context) as RunWorkspace;
      for (const [id, image] of [
        ['attachment-1', { data, mediaType: 'image/png' }],
        ['attachment-2', { url: 'https://example.com/image.png', mediaType: 'image/png' }],
      ] as const) {
        const call = { runId: 'image_run', tool: 'inspect_attachment', input: { attachment_id: id } };
        const risk = await executor.handle('executor.assess', call, context) as ToolRiskAssessment & { grant: string };
        expect(risk).toMatchObject({ trusted: true, escalate: false, persistable: false, blocked: false });
        const result = await executor.handle('executor.execute', { ...call, grant: risk.grant }, context) as ToolExecutionResult;
        expect(JSON.parse(JSON.stringify(result)).images).toEqual([image]);
        await expect(executor.handle('executor.execute', { ...call, grant: risk.grant }, context)).rejects.toThrow('invalid or expired');
      }
      const read = await executor.handle('executor.assess', {
        runId: 'image_run', tool: 'read_file', input: { path: workspace.workDir },
      }, context) as ToolRiskAssessment;
      expect(read).toMatchObject({ trusted: false, escalate: true, blocked: true });
      const invalid = { runId: 'image_run', tool: 'inspect_attachment', input: { attachment_id: '/etc/passwd' } };
      const risk = await executor.handle('executor.assess', invalid, context) as { grant: string };
      const result = await executor.handle('executor.execute', { ...invalid, grant: risk.grant }, context) as ToolExecutionResult;
      expect(result.isError).toBe(true);
      expect(result.images).toBeUndefined();

      const imagePath = workspace.attachments[0].path!;
      fs.unlinkSync(imagePath);
      fs.writeFileSync(path.join(d, 'private.png'), Buffer.from(data, 'base64'));
      fs.symlinkSync(path.join(d, 'private.png'), imagePath);
      const call = { runId: 'image_run', tool: 'inspect_attachment', input: { attachment_id: 'attachment-1' } };
      const grant = await executor.handle('executor.assess', call, context) as { grant: string };
      await expect(executor.handle('executor.execute', { ...call, grant: grant.grant }, context)).rejects.toThrow();
    } finally {
      executor.close();
    }
  });
  it('retains session downloads and child provenance after live expiry, capacity eviction, and restart', async () => {
    const config = path.join(directory(), 'config.toml');
    const first = store(config);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const record = (id: string): RunRecord => ({
      id, objective: 'Screenshot', profile: 'default', status: 'completed',
      createdAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(),
      eventCount: 2, pendingApprovals: [], pendingUserInputs: [],
      artifacts: [{ id: 'a'.repeat(24), name: 'home-desktop.png', mediaType: 'image/png', size: 4 }],
      execution: { workspaceId: 'home', originDeviceId: 'office', executionDeviceId: 'host' },
    });
    const child = { ...record('child'), parentRunId: 'parent' };
    const parent = { ...record('parent'), sessionId: 'session-screenshot', artifacts: [
      { ...record('parent').artifacts![0], source: { runId: 'child', artifactId: 'a'.repeat(24) } },
    ] };
    first.runJournal.save(child);
    first.runJournal.save(parent);
    for (let i = 0; i < 60; i++) first.runJournal.save({ ...record(`other-${i}`), sessionId: 'other-session', artifacts: [] });
    first.close();
    clock.mockReturnValue(now + 2 * 86400000);
    const restarted = store(config);
    const registry = new RunRegistry({ journal: restarted.runJournal, runtime: {
      createAgentRunner: () => { throw new Error('Must not recreate the screenshot'); },
      setProfileAgentApproval: () => undefined,
      addProfileTrustedFolder: (_p, f) => f,
      defaultProfile: () => 'default',
    } });
    try {
      expect(registry.list()).toEqual([]);
      expect(registry.list('session-screenshot')).toEqual([parent]);
      expect(registry.list('unknown-session')).toEqual([]);
      expect(registry.require('parent')).toEqual(parent);
      expect(registry.artifactOrigin('parent', 'a'.repeat(24))).toEqual({ run: child, artifactId: 'a'.repeat(24) });
      expect(() => registry.artifactOrigin('parent', 'b'.repeat(24))).toThrow();
      expect(registry.require('parent').pendingApprovals).toEqual([]);
      const events = [];
      for await (const event of registry.events('parent')) events.push(event);
      expect(events).toEqual([{ seq: 2, event: { type: 'done', taskId: '', status: 'completed' } }]);
      const caughtUp = [];
      for await (const event of registry.events('parent', 2)) caughtUp.push(event);
      expect(caughtUp).toEqual([]);
      expect(() => registry.steer('parent', 'capture again')).toThrow();
    } finally { registry.close(); }
  });

  it('never replays an operation left running by a previous service process', async () => {
    const config = path.join(directory(), 'config.toml');
    const first = store(config);
    let release!: () => void;
    let effects = 0;
    const pending = first.once('workspace', 'device', 'operation', { write: true }, async () => {
      effects++;
      await new Promise<void>((r) => {
        release = r;
      });
      return 'written';
    });
    first.close();
    const second = store(config);
    second.interruptRequests();
    await expect(
      second.once('workspace', 'device', 'operation', { write: true }, async () => {
        effects++;
        return 'duplicate';
      }),
    ).rejects.toThrow('outcome is unknown');
    release();
    await pending;
    expect(effects).toBe(1);
    await expect(
      second.once('workspace', 'device', 'operation', { write: true }, async () => 'duplicate'),
    ).rejects.toThrow('outcome is unknown');
  });
  it('isolates configurations and rejects loose or symlinked credential files', async () => {
    const d = directory();
    const a = store(path.join(d, 'a.toml'));
    const b = store(path.join(d, 'b.toml'));
    const created = await a.create('home', 'http://localhost:3000', 'host');
    expect(b.list()).toEqual([]);
    const credentials = path.join(a.directory, `${created.id}.credentials.json`);
    fs.chmodSync(credentials, 0o644);
    expect(() => a.list()).toThrow('owner-only');
    fs.rmSync(credentials);
    fs.symlinkSync(path.join(d, 'outside'), credentials);
    expect(() => a.list()).toThrow();
  });
  it('rejects a second service for the same configuration and permits a clean restart', () => {
    const config = path.join(directory(), 'config.toml');
    const first = store(config);
    expect(() => store(config)).toThrow('active workspace service');
    first.close();
    expect(store(config).list()).toEqual([]);
  });
  it('recovers only scoped artifacts after executor restart, never execution grants', async () => {
    const d = directory();
    const runs = path.join(d, 'runs');
    const context = { workspaceId: 'home', senderDeviceId: 'host', hostDeviceId: 'host' };
    const first = new WorkspaceExecutor(() => resolveAgentConfig({}), runs);
    const workspace = (await first.handle('executor.prepare', { runId: 'artifact_run' }, context)) as RunWorkspace;
    fs.writeFileSync(path.join(workspace.outputDir, 'result.txt'), 'durable output');
    const artifacts = (await first.handle('executor.artifacts', { runId: 'artifact_run' }, context)) as {
      id: string;
    }[];
    first.close();
    const second = new WorkspaceExecutor(() => resolveAgentConfig({}), runs);
    try {
      expect(await second.handle('executor.artifact', { runId: 'artifact_run', artifactId: artifacts[0].id, metadata: true }, context)).toEqual({ available: true });
      const chunk = (await second.handle(
        'executor.artifact',
        { runId: 'artifact_run', artifactId: artifacts[0].id, offset: 0 },
        context,
      )) as { data: string };
      expect(Buffer.from(chunk.data, 'base64').toString()).toBe('durable output');
      await expect(
        second.handle(
          'executor.artifact',
          { runId: 'artifact_run', artifactId: artifacts[0].id, offset: 0 },
          { ...context, workspaceId: 'office' },
        ),
      ).rejects.toThrow('unavailable');
      await expect(
        second.handle('executor.execute', { runId: 'artifact_run', tool: 'write_file', input: {} }, context),
      ).rejects.toThrow('unavailable');
      fs.writeFileSync(path.join(workspace.outputDir, 'desktop.png'), await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#37576a' } }).png().toBuffer());
      const image = listRunArtifacts(workspace).find(artifact => artifact.name === 'desktop.png')!;
      const preview = await second.handle('executor.artifact', { runId: 'artifact_run', artifactId: image.id, preview: true }, context) as { data: string };
      expect(await sharp(Buffer.from(preview.data, 'base64')).metadata()).toMatchObject({ width: 480, height: 270, format: 'webp' });
      await expect(second.handle('executor.artifact', { runId: 'artifact_run', artifactId: image.id, preview: true }, { ...context, workspaceId: 'office' })).rejects.toThrow('unavailable');
      fs.rmSync(workspace.outputDir, { recursive: true });
      expect(await second.handle('executor.artifact', { runId: 'artifact_run', artifactId: artifacts[0].id, metadata: true }, context)).toEqual({ available: false });
      fs.symlinkSync(d, workspace.outputDir);
      expect(listRunArtifacts(workspace)).toEqual([]);
      await expect(
        second.handle('executor.artifact', { runId: 'artifact_run', artifactId: artifacts[0].id, offset: 0 }, context),
      ).rejects.toThrow('unavailable');
    } finally {
      second.close();
    }
  });
  it.runIf(process.platform === 'darwin')(
    'denies other workspace state in real sandboxed processes even under a broad project root',
    async () => {
      const d = directory();
      const protectedRoot = path.join(d, 'private');
      fs.mkdirSync(protectedRoot);
      const secret = path.join(protectedRoot, 'credentials');
      fs.writeFileSync(secret, 'private-state-canary');
      const executor = new WorkspaceExecutor(() => resolveAgentConfig({}), path.join(protectedRoot, 'runs'), [
        protectedRoot,
      ]);
      const context = { workspaceId: 'home', senderDeviceId: 'host', hostDeviceId: 'host' };
      try {
        const workspace = (await executor.handle(
          'executor.prepare',
          { runId: 'sandbox_run', cwd: d },
          context,
        )) as RunWorkspace;
        const risk = (await executor.handle(
          'executor.assess',
          { runId: 'sandbox_run', tool: 'read_file', input: { path: secret } },
          context,
        )) as { blocked: boolean };
        expect(risk.blocked).toBe(true);
        const output = path.join(workspace.outputDir, 'allowed.txt');
        fs.writeFileSync(output, 'own-output');
        const options = {
          executable: '/bin/cat',
          workspace,
          outputLimit: 1000,
          successSummary: 'read',
          failureSummary: 'blocked',
        };
        const denied = await runScopedProcess({ ...options, args: [secret] });
        expect(denied.isError).toBe(true);
        expect(denied.content).not.toContain('private-state-canary');
        const allowed = await runScopedProcess({ ...options, args: [output] });
        expect(allowed.isError).toBeFalsy();
        expect(allowed.content).toContain('own-output');
      } finally {
        executor.close();
      }
    },
  );
  it('returns an interrupted run after restart without invoking its model', async () => {
    const s = store();
    s.runJournal.save(
      {
        id: 'run_interrupted',
        objective: 'write',
        profile: 'default',
        status: 'running',
        createdAt: new Date().toISOString(),
        eventCount: 1,
        pendingApprovals: [],
        pendingUserInputs: [],
        execution: { workspaceId: 'w', originDeviceId: 'b', executionDeviceId: 'b' },
      },
      { seq: 1, event: { type: 'status', taskId: 'task', status: 'running' } },
    );
    const registry = new RunRegistry({
      journal: s.runJournal,
      runtime: {
        createAgentRunner: () => {
          throw new Error('Model must not restart');
        },
        setProfileAgentApproval: () => undefined,
        addProfileTrustedFolder: (_p, f) => f,
        defaultProfile: () => 'default',
      },
    });
    try {
      const record = registry.require('run_interrupted');
      expect(record.status).toBe('failed');
      expect(record.summary).toContain('Interrupted');
      const events = [];
      for await (const e of registry.events(record.id, 1)) events.push(e);
      expect(events).toHaveLength(1);
      expect(events[0].event.type).toBe('done');
    } finally {
      registry.close();
    }
  });
  it('binds execution grants to one workspace, run, tool and input', async () => {
    const d = directory();
    const work = path.join(d, 'project');
    fs.mkdirSync(work);
    const executor = new WorkspaceExecutor(() => resolveAgentConfig({}), path.join(d, 'state', 'runs'));
    const context = { workspaceId: 'workspace', senderDeviceId: 'host', hostDeviceId: 'host' };
    const input = { path: 'output.txt', content: 'authorized' };
    try {
      await executor.handle('executor.prepare', { runId: 'run', cwd: work }, context);
      const assessment = (await executor.handle(
        'executor.assess',
        { runId: 'run', tool: 'write_file', input },
        context,
      )) as { grant: string };
      await expect(
        executor.handle(
          'executor.execute',
          { runId: 'run', tool: 'write_file', input: { ...input, content: 'changed' }, grant: assessment.grant },
          context,
        ),
      ).rejects.toThrow('invalid or expired');
      expect(fs.existsSync(path.join(work, 'output.txt'))).toBe(false);
      const next = (await executor.handle('executor.assess', { runId: 'run', tool: 'write_file', input }, context)) as {
        grant: string;
      };
      await expect(
        executor.handle(
          'executor.execute',
          { runId: 'run', tool: 'write_file', input, grant: next.grant },
          { ...context, workspaceId: 'other' },
        ),
      ).rejects.toThrow('unavailable');
      await executor.handle(
        'executor.execute',
        { runId: 'run', tool: 'write_file', input, grant: next.grant },
        context,
      );
      expect(fs.readFileSync(path.join(work, 'output.txt'), 'utf8')).toBe('authorized');
      await expect(
        executor.handle('executor.execute', { runId: 'run', tool: 'write_file', input, grant: next.grant }, context),
      ).rejects.toThrow('invalid or expired');
    } finally {
      executor.close();
    }
  });
});
