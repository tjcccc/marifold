import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runArtifactId } from '../src/agent/RunArtifacts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/AgentEvents';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import type { ToolExecutionContext } from '../src/agent/ToolRegistry';
import { ArtifactLibrary } from '../src/artifacts/ArtifactLibrary';
import { type ArtifactRun, artifactInstructions, artifactTools, asksForArtifact, resolveArtifactReferences } from '../src/artifacts/ArtifactTools';
import { hostRunOutputs, type RunOutputs } from '../src/projects/ProjectAssetTools';

// A run's artifact tools (docs/artifacts.md#agent-tools): what a run can see,
// and saving bundles from its output folder.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) { cleanup(); } });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-artifact-tools-'));
  const library = new ArtifactLibrary(path.join(dir, 'artifacts'));
  cleanups.push(() => { library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const outputDir = path.join(dir, 'run', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const events: AgentEvent[] = [];
  const ctx = { cwd: dir, outputLimit: 20000, workspace: { outputDir, workDir: path.join(dir, 'run', 'work') } as RunWorkspace, emitEvent: (event: AgentEvent) => events.push(event) } as ToolExecutionContext;
  const write = (relative: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(outputDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(outputDir, relative), text);
  };
  const run = (overrides: Partial<ArtifactRun> = {}): ArtifactRun => ({ library, profile: 'default', sessionId: 's1', runId: 'run_1', referenced: new Set(), outputs: hostRunOutputs, mayCreate: true, ...overrides });
  const call = async (target: ArtifactRun, name: string, input: Record<string, unknown>) => {
    const tool = artifactTools(target).find(entry => entry.definition.name === name)!;
    return tool.execute(input as never, ctx);
  };
  return { library, ctx, events, write, run, call };
}

const file = (filePath: string, text: string) => ({ path: filePath, data: Buffer.from(text) });

describe('artifact tools', () => {
  it('creates an artifact only when the user asked for one; a new version of one in scope is always allowed', async () => {
    const { library, write, run, call } = setup();
    expect(asksForArtifact('Make a simple html with three.js.')).toBe(false);
    expect(asksForArtifact('make a page and save it as an Artifact')).toBe(true);
    expect(asksForArtifact('update @[Daily News] with today')).toBe(true);
    expect(asksForArtifact('make it bigger', ['k3m7q2x9ab'])).toBe(true);
    write('page/index.html', '<h1>v1</h1>');
    const refused = await call(run({ mayCreate: false }), 'save_artifact', { title: 'Earth', dir: 'page' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/did not ask for an artifact/);
    expect(library.list()).toEqual([]);
    expect(artifactInstructions(run({ mayCreate: false }), { ids: [], ambiguous: [], unknown: [] })).toMatch(/does not ask for an artifact, so do not create one/);
    const page = library.create({ title: 'Earth', files: [{ path: 'index.html', data: Buffer.from('<h1>v0</h1>') }], sessionId: 's1' });
    const updated = await call(run({ mayCreate: false }), 'save_artifact', { artifact_id: page.id, dir: 'page' });
    expect(updated.isError).toBeFalsy();
    expect(library.get(page.id)?.currentVersion).toBe(2);
  });

  it('saves every file under dir as one bundle and reports it', async () => {
    const { library, write, run, call, events } = setup();
    write('site/index.html', '<link href="css/a.css">');
    write('site/css/a.css', 'body{}');
    write('notes.txt', 'not part of it');
    const result = await call(run(), 'save_artifact', { title: 'AI News', dir: 'site', folder: 'AI News' });
    expect(result.isError).toBeFalsy();
    const [saved] = library.list();
    expect(library.get(saved!.id)?.files.map(item => item.path)).toEqual(['css/a.css', 'index.html']);
    // The entry's output id, so its output row offers to open it rather than save a copy.
    expect(saved).toMatchObject({ sessionId: 's1', runId: 'run_1', createdBy: 'default', sourceOutput: runArtifactId('site/index.html') });
    expect(library.folders().map(folder => folder.name)).toEqual(['AI News']);
    expect(events).toEqual([{ type: 'artifact_saved', artifact: { id: saved!.id, title: 'AI News', kind: 'html', version: 1 } }]);
  });

  it('saves a dir or listed files when the run executes on another device, refusing a capped listing', async () => {
    const { library, run, call } = setup();
    let listing = ['notes.txt', 'report/.DS_Store', 'report/img/chart.svg', 'report/index.md'];
    const remote: RunOutputs = { local: false, list: async () => listing, read: async relative => ({ data: Buffer.from(`# ${relative}`), mediaType: 'text/markdown' }) };
    const byDir = await call(run({ outputs: remote }), 'save_artifact', { title: 'From dir', dir: 'report' });
    expect(byDir.isError).toBeFalsy();
    expect(library.get(library.list()[0]!.id)!.files.map(item => item.path)).toEqual(['img/chart.svg', 'index.md']);
    listing = Array.from({ length: 50 }, (_, index) => `report/f${index}.md`);
    expect((await call(run({ outputs: remote }), 'save_artifact', { title: 'x', dir: 'report' })).content).toMatch(/list the bundle's files/);
    library.purge(library.list()[0]!.id);
    const result = await call(run({ outputs: remote }), 'save_artifact', { title: 'Report', dir: 'report', files: ['index.md', 'img/chart.svg'] });
    expect(result.isError).toBeFalsy();
    const detail = library.get(library.list()[0]!.id)!;
    expect(detail.files.map(item => item.path)).toEqual(['img/chart.svg', 'index.md']);
    expect(fs.readFileSync(library.file(detail.id, 1, 'index.md')!.absolutePath, 'utf8')).toBe('# report/index.md');
    expect((await call(run({ outputs: remote }), 'save_artifact', { title: 'x', files: ['../escape.md'] })).isError).toBe(true);
  });

  it('sees its session, its project, and mentioned artifacts, never another session\'s', async () => {
    const { library, run, call } = setup();
    const mine = library.create({ title: 'Mine', files: [file('index.md', 'mine')], sessionId: 's1' });
    const shared = library.create({ title: 'Project brief', files: [file('index.md', 'brief')], sessionId: 's9', projectId: 'p1' });
    const other = library.create({ title: 'Weekly digest', files: [file('index.md', 'secret')], sessionId: 's2' });

    const plain = run();
    expect((await call(plain, 'list_artifacts', {})).content).toContain(mine.id);
    expect((await call(plain, 'list_artifacts', {})).content).not.toContain(shared.id);
    expect((await call(plain, 'read_artifact', { artifact_id: other.id })).isError).toBe(true);
    expect((await call(plain, 'save_artifact', { title: 'x', artifact_id: other.id, files: ['a.md'] })).isError).toBe(true);
    expect((await call(run({ projectId: 'p1' }), 'read_artifact', { artifact_id: shared.id })).content).toContain('brief');

    const references = resolveArtifactReferences(library, 'Compare @[weekly digest] with @[nothing]');
    expect(references).toMatchObject({ ids: [other.id], unknown: ['nothing'] });
    const mentioned = run({ referenced: new Set(references.ids) });
    expect((await call(mentioned, 'read_artifact', { artifact_id: other.id })).content).toContain('secret');
    expect(artifactInstructions(mentioned, references)).toMatch(/No artifact matches @\[nothing\]/);
  });

  it('lists the ids of an ambiguous title instead of picking one', () => {
    const { library } = setup();
    const first = library.create({ title: 'AI News', files: [file('index.md', '1')] });
    const second = library.create({ title: 'ai news', files: [file('index.md', '2')] });
    const references = resolveArtifactReferences(library, '@[AI News] again');
    expect(references.ids).toEqual([]);
    expect(references.ambiguous[0]?.candidates.map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    // A picked chip settles its title.
    expect(resolveArtifactReferences(library, '@[AI News] again', [second.id])).toEqual({ ids: [second.id], ambiguous: [], unknown: [] });
  });

  it('reads past the output listing cap, skips hidden files, and keeps the title on a new version', async () => {
    const { library, write, run, call } = setup();
    for (let index = 0; index < 60; index++) { write(`a${String(index).padStart(2, '0')}.txt`, 'x'); }
    write('site/index.html', 'v1');
    write('site/.DS_Store', 'junk');
    const first = await call(run(), 'save_artifact', { title: 'Site', dir: 'site' });
    expect(first.isError).toBeFalsy();
    const saved = library.list()[0]!;
    expect(library.get(saved.id)?.files.map(item => item.path)).toEqual(['index.html']);
    library.update(saved.id, { title: 'Renamed by the user' });
    write('site/index.html', 'v2');
    await call(run(), 'save_artifact', { title: 'Site', artifact_id: saved.id, dir: 'site', files: ['index.html'] });
    expect(library.get(saved.id)).toMatchObject({ title: 'Renamed by the user', currentVersion: 2 });
  });

  it('refuses a bundle over the version size before reading it all', async () => {
    const { write, run, call } = setup();
    write('big/index.html', 'x'.repeat(26 * 1024 * 1024));
    expect((await call(run(), 'save_artifact', { title: 'Big', dir: 'big' })).content).toMatch(/at most 25/);
  });

  it('saves a new version of an artifact it can use', async () => {
    const { library, write, run, call } = setup();
    const saved = library.create({ title: 'Report', files: [file('index.md', 'one')], sessionId: 's1' });
    write('index.md', 'two');
    const result = await call(run(), 'save_artifact', { title: 'Report', artifact_id: saved.id, files: ['index.md'], note: 'update' });
    expect(result.content).toMatch(/version 2/);
    expect(library.get(saved.id)?.versions.map(version => version.note ?? '')).toEqual(['', 'update']);
  });
});
