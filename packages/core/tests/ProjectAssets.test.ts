import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime, planProjectTurn } from '../src';
import type { AgentEvent } from '../src/agent/AgentEvents';
import { runArtifactId } from '../src/agent/RunArtifacts';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import type { ToolExecutionContext } from '../src/agent/ToolRegistry';
import type { MarifoldConfig } from '../src/config/ConfigSchema';
import { deviceRunOutputs, hostRunOutputs, outputRelativePath, projectAssetTools, type RunOutputs } from '../src/projects/ProjectAssetTools';
import type { RunRegistry } from '../src/runs/RunRegistry';
import type { WorkspaceManager } from '../src/workspace/WorkspaceManager';
import { WorkspaceRuns } from '../src/workspace/WorkspaceRuns';

// Stored project assets (docs/projects.md#assets): the store, the agent tools,
// and the manifest each speaker's run gets.

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) { cleanup(); }
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-assets-'));
  dirs.push(dir);
  const config = {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
  } as MarifoldConfig;
  const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true } });
  for (const name of ['painter', 'dev_test']) { runtime.initProfile(name); }
  cleanups.push(() => runtime.close());
  const game = runtime.projects.create({ name: 'Game', lead: 'default', members: ['painter', 'dev_test'] });
  return { dir, runtime, game, assets: runtime.projects.assets };
}

function context(dir: string, outputLimit = 10_000): ToolExecutionContext & { workspace: RunWorkspace } {
  const workspace = { outputDir: path.join(dir, 'run', 'output'), workDir: path.join(dir, 'run', 'work') } as RunWorkspace;
  fs.mkdirSync(workspace.outputDir, { recursive: true });
  return { cwd: dir, outputLimit, workspace };
}

function tools(setupResult: ReturnType<typeof setup>, outputs: RunOutputs = hostRunOutputs) {
  const [list, read, save] = projectAssetTools({ assets: setupResult.assets, projectId: setupResult.game.id, profile: 'painter', runId: 'run_1', outputs });
  return { list: list!, read: read!, save: save! };
}

describe('project asset store', () => {
  it('versions a name, stores equal content once, and holds the limit across versions', () => {
    const { dir, runtime, game, assets } = setup();
    const first = assets.save(game.id, { name: 'report.md', data: Buffer.from('v1'), mediaType: 'text/markdown', description: 'Weekly report' });
    expect(first).toMatchObject({ newVersion: true, asset: { name: 'report.md', version: 1, size: 2, description: 'Weekly report' } });
    // Same content again adds nothing; a name differing only in case is the same asset.
    expect(assets.save(game.id, { name: 'REPORT.md', data: Buffer.from('v1'), mediaType: 'text/markdown' })).toMatchObject({ newVersion: false, asset: { version: 1 } });
    expect(assets.save(game.id, { name: 'report.md', data: Buffer.from('v2!'), mediaType: 'text/markdown', savedBy: 'painter', runId: 'run_1' }).asset)
      .toMatchObject({ version: 2, size: 3, savedBy: 'painter', description: 'Weekly report' });
    expect(assets.versions(game.id, first.asset.id).map(version => [version.version, version.runId])).toEqual([[2, 'run_1'], [1, undefined]]);
    expect(fs.readFileSync(assets.content(game.id, first.asset.id, 1).path, 'utf8')).toBe('v1');
    // A copy under another name is stored and counted once.
    assets.save(game.id, { name: 'copy.md', data: Buffer.from('v2!'), mediaType: 'text/markdown' });
    expect(assets.list(game.id).usage).toEqual({ usedBytes: 5, limitBytes: 100 * 1024 * 1024 });
    expect(fs.readdirSync(path.join(dir, 'projects', game.id, 'assets'))).toHaveLength(2);

    runtime.projects.update(game.id, { assetLimitBytes: 1024 * 1024 });
    const big = Buffer.alloc(1024 * 1024 - 5);
    assets.save(game.id, { name: 'big.bin', data: big, mediaType: 'application/octet-stream' });
    expect(() => assets.save(game.id, { name: 'more.bin', data: Buffer.from('x'), mediaType: 'application/octet-stream' })).toThrow(/would use 1 MB of its 1 MB limit/);
    // Content already stored costs nothing more.
    expect(assets.save(game.id, { name: 'big copy.bin', data: big, mediaType: 'application/octet-stream' }).newVersion).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'projects', game.id, 'assets')).filter(file => file.endsWith('.tmp'))).toEqual([]);
    expect(() => runtime.projects.update(game.id, { assetLimitBytes: 10 })).toThrow(/from 1 MB to 1 TB/);
    expect(runtime.projects.update(game.id, { assetLimitBytes: null }).assetLimitBytes).toBe(100 * 1024 * 1024);
    expect(() => assets.save(game.id, { name: '../x', data: Buffer.from('x'), mediaType: 'text/plain' })).toThrow(/without \/ or \\/);
    expect(() => assets.update(game.id, first.asset.id, { name: 'copy.MD' })).toThrow(/already exists/);
  });

  it('removes content no version uses, and everything with the project', () => {
    const { dir, runtime, game, assets } = setup();
    const shared = Buffer.from('shared');
    const a = assets.save(game.id, { name: 'a.txt', data: shared, mediaType: 'text/plain' }).asset;
    const b = assets.save(game.id, { name: 'b.txt', data: shared, mediaType: 'text/plain' }).asset;
    assets.save(game.id, { name: 'b.txt', data: Buffer.from('only b'), mediaType: 'text/plain' });
    const folder = path.join(dir, 'projects', game.id, 'assets');
    assets.delete(game.id, b.id);
    expect(fs.readdirSync(folder)).toEqual([a.sha256]);
    expect(() => assets.content(game.id, b.id)).toThrow(/Asset not found/);
    runtime.projects.setIcon(game.id, Buffer.from('png'), 'image/png');

    runtime.projects.delete(game.id);
    expect(fs.existsSync(path.join(dir, 'projects', game.id))).toBe(false);
    const again = runtime.projects.create({ name: 'Game', lead: 'default' });
    expect(assets.list(again.id).assets).toEqual([]);
    expect(() => assets.list(game.id)).toThrow(/Project not found/);
  });
});

describe('project asset tools', () => {
  it('saves only files inside the run output folder, without approval', async () => {
    const setupResult = setup();
    const { save, read } = tools(setupResult);
    const ctx = context(setupResult.dir);
    fs.mkdirSync(path.join(ctx.workspace.outputDir, 'charts'));
    fs.writeFileSync(path.join(ctx.workspace.outputDir, 'charts', 'plan.md'), '# Plan');
    fs.writeFileSync(path.join(setupResult.dir, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(setupResult.dir, 'secret.txt'), path.join(ctx.workspace.outputDir, 'link.txt'));

    expect(await save.assessRisk!({ path: 'x' }, ctx)).toEqual({ escalate: false, routine: true });
    expect(save.kind).toBe('write');
    expect(await save.execute({ path: 'charts/plan.md', description: 'The plan' }, ctx)).toMatchObject({ content: 'Saved plan.md as version 1 (6 B).' });
    expect(await save.execute({ path: path.join(ctx.workspace.outputDir, 'charts', 'plan.md'), name: 'plan v2.md' }, ctx)).toMatchObject({ content: 'Saved plan v2.md as version 1 (6 B).' });
    expect(setupResult.assets.find(setupResult.game.id, 'plan.md')).toMatchObject({ mediaType: 'text/markdown; charset=utf-8', savedBy: 'painter', description: 'The plan' });
    for (const outside of ['../secret.txt', path.join(setupResult.dir, 'secret.txt'), '~/secret.txt']) {
      expect(await save.execute({ path: outside }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("is not in this run's output folder") });
    }
    expect(await save.execute({ path: 'link.txt' }, ctx)).toMatchObject({ isError: true, content: "No file at link.txt in this run's output folder." });
    expect(await save.execute({ content: 'notes', name: 'notes.md' }, ctx)).toMatchObject({ content: 'Saved notes.md as version 1 (5 B).' });
    expect(await save.execute({ content: 'notes' }, ctx)).toMatchObject({ isError: true, content: 'Saving content needs a name.' });
    expect(await read.execute({ name: 'NOTES.md' }, ctx)).toMatchObject({ content: 'Asset notes.md v1 (text/markdown, 5 B):\nnotes' });
  });

  it('copies a binary asset into the work folder on the host, and refuses it where tools run elsewhere', async () => {
    const setupResult = setup();
    const ctx = context(setupResult.dir);
    setupResult.assets.save(setupResult.game.id, { name: 'level.bin', data: Buffer.from([0, 1, 2]), mediaType: 'application/octet-stream' });
    const copied = await tools(setupResult).read.execute({ name: 'level.bin' }, ctx);
    const copy = path.join(ctx.workspace.workDir, 'assets', 'v1', 'level.bin');
    expect(copied.content).toBe(`Asset level.bin v1 is a application/octet-stream file (3 B); a copy for this run's tools is at ${copy}.`);
    expect(fs.readFileSync(copy)).toEqual(Buffer.from([0, 1, 2]));
    const remote = await tools(setupResult, { local: false, read: async () => { throw new Error('unused'); } }).read.execute({ name: 'level.bin' }, ctx);
    expect(remote).toMatchObject({ isError: true, content: expect.stringContaining('only when the run executes on the workspace host') });
    expect(await tools(setupResult).read.execute({ name: 'nope' }, ctx)).toMatchObject({ isError: true, content: "No asset named 'nope'. Assets: level.bin." });
  });

  it('reads a guest output over the bridge in chunks, by its artifact id', async () => {
    const data = Buffer.alloc(300 * 1024, 7);
    const calls: Array<{ artifactId: string; offset: number; length: number }> = [];
    const outputs = deviceRunOutputs(async request => {
      calls.push(request);
      if (request.artifactId !== runArtifactId('maps/level.bin')) { throw new Error('Artifact is unavailable.'); }
      return { data: data.subarray(request.offset, request.offset + request.length).toString('base64'), size: data.length };
    });
    const ctx = context(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-assets-')));
    dirs.push(ctx.cwd);
    expect(await outputs.read('maps/level.bin', ctx)).toEqual({ data, mediaType: 'application/octet-stream' });
    expect(calls[0]).toEqual({ artifactId: runArtifactId('maps/level.bin'), offset: 0, length: 1 });
    await expect(outputs.read('missing.png', ctx)).rejects.toThrow("No file at missing.png in this run's output folder.");
    expect(outputRelativePath('C:\\runs\\r1\\output\\a\\b.png', 'C:\\runs\\r1\\output')).toBe('a/b.png');
    expect(outputRelativePath('a/../../b.png', '/runs/r1/output')).toBeUndefined();
  });
});

describe('project asset manifest', () => {
  it("lists each speaker's assets as its run starts, so a later speaker sees an earlier one's save", async () => {
    const setupResult = setup();
    const { runtime, game, assets } = setupResult;
    const workspaceRuns = new WorkspaceRuns(runtime, {} as WorkspaceManager);
    const registry = runtime.createRunRegistry(undefined, input => workspaceRuns.createRunner(input));
    cleanups.push(() => registry.close());
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      // painter saves while it answers.
      if (bodies.length === 1) { assets.save(game.id, { name: 'logo.png', data: Buffer.from('png'), mediaType: 'image/png', savedBy: 'painter' }); }
      return new Response(`${JSON.stringify({ message: { content: 'reply' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 })}\n`, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const input = { objective: '@painter @dev_test make a logo', sessionId: 's', cwd: setupResult.dir };
    const project = planProjectTurn({ projects: runtime.projects, profileNames: () => runtime.listProfiles().map(profile => profile.name), sessionExists: id => runtime.getSession(id) !== undefined }, input, game.id)!;
    const first = registry.start({ ...input, projectTurn: project.plan });
    const handoff = (await drain(registry, first.id)).find(event => event.type === 'handoff') as Extract<AgentEvent, { type: 'handoff' }>;
    await drain(registry, handoff.runId);

    expect(bodies[0]).toContain('"save_asset"');
    expect(bodies[0]).toContain('## Project assets');
    expect(bodies[0]).toContain('There are none yet.');
    expect(bodies.at(-1)).toContain('- logo.png (image/png, 3 B, v1, saved by painter)');
  });
});

async function drain(registry: RunRegistry, runId: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const { event } of registry.events(runId, 0)) { events.push(event); }
  return events;
}
