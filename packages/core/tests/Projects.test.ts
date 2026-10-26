import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarifoldRuntime } from '../src';
import type { MarifoldConfig } from '../src/config/ConfigSchema';
import { SessionResolver } from '../src/sessions/SessionResolver';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function setup(deviceNames?: () => string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-projects-'));
  dirs.push(dir);
  const config = {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks'), schedulesDir: path.join(dir, 'schedules') },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
  } as MarifoldConfig;
  const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true }, ...(deviceNames ? { deviceNames } : {}) });
  for (const name of ['painter', 'dev_test']) { runtime.initProfile(name); }
  const sessions = new SessionResolver(config.paths.sessionsDb);
  return { runtime, sessions, dir };
}

describe('projects', () => {
  it('keeps the Lead on the roster, validates names and profiles, and lists by name', () => {
    const { runtime } = setup();
    const game = runtime.projects.create({ name: '  Game dev discuss ', lead: 'default', members: ['dev_test', 'default'] });
    expect(game).toMatchObject({ name: 'Game dev discuss', lead: 'default', members: ['default', 'dev_test'], sessionCount: 0, instructions: '' });
    runtime.projects.create({ name: 'a talk show', lead: 'painter' });
    expect(runtime.projects.list().map(project => project.name)).toEqual(['a talk show', 'Game dev discuss']);
    expect(() => runtime.projects.create({ name: 'GAME DEV DISCUSS', lead: 'default' })).toThrow(/already exists/);
    expect(() => runtime.projects.create({ name: ' ', lead: 'default' })).toThrow(/1–100/);
    expect(() => runtime.projects.create({ name: 'x', lead: 'nobody' })).toThrow(/Profile not found/);
    expect(() => runtime.projects.invite(game.id, '../etc')).toThrow(/Profile not found/);
    expect(runtime.projects.update(game.id, { lead: 'painter', description: 'robots' })).toMatchObject({ lead: 'painter', members: ['default', 'dev_test', 'painter'], description: 'robots' });
    expect(runtime.projects.update(game.id, { description: null }).description).toBeUndefined();
  });

  it('moves a session in: it leaves the profile lists, its profile joins and holds the floor, and dismissal returns it to the Lead', async () => {
    const { runtime, sessions } = setup();
    await sessions.appendExchange('s1', 'painter', 'draw a robot', 'Here is a robot.');
    await sessions.appendExchange('s2', 'painter', 'hello', 'Hi there.');
    const game = runtime.projects.create({ name: 'Game dev discuss', lead: 'default' });

    expect(runtime.projects.moveSession('s1', game.id)).toEqual({ projectId: game.id, floor: 'painter' });
    expect(runtime.projects.get(game.id)).toMatchObject({ members: ['default', 'painter'], sessionCount: 1 });
    expect(runtime.getSession('s1')?.projectId).toBe(game.id);
    expect(runtime.getSession('s2')?.projectId).toBeUndefined();
    expect(runtime.listSessions(50, 'painter').map(session => session.id)).toEqual(['s2']);
    expect(runtime.listSessions(50, undefined, { projectId: game.id }).map(session => [session.id, session.speakers])).toEqual([['s1', ['painter']]]);
    // Clearing a profile's sessions leaves its project sessions alone.
    expect(runtime.clearSessions({ profileName: 'painter' }).ids).toEqual(['s2']);
    expect(runtime.getSession('s1')).toBeDefined();

    expect(() => runtime.projects.dismiss(game.id, 'default')).toThrow(/leads this project/);
    runtime.projects.dismiss(game.id, 'painter');
    expect(runtime.projects.sessionProject('s1')).toEqual({ projectId: game.id });
    expect(() => runtime.projects.dismiss(game.id, 'painter')).toThrow(/not on this project's roster/);
    expect(() => runtime.projects.setFloor('s1', 'painter')).toThrow(/not on this project's roster/);
    runtime.projects.invite(game.id, 'painter');
    runtime.projects.setFloor('s1', 'painter');
    expect(runtime.projects.sessionProject('s1')?.floor).toBe('painter');

    expect(runtime.projects.delete(game.id)).toEqual({ sessions: 1 });
    expect(runtime.listSessions(50, 'painter').map(session => session.id)).toEqual(['s1']);
    expect(() => runtime.projects.moveSession('missing', null)).toThrow(/Session not found/);
  });

  it("gives a deleted profile's session to the Lead, and keeps links through session rename and delete", async () => {
    const { runtime, sessions } = setup();
    await sessions.appendExchange('orphan', 'painter', 'q', 'a');
    runtime.deleteProfile('painter');
    const game = runtime.projects.create({ name: 'Game', lead: 'default' });
    expect(runtime.projects.moveSession('orphan', game.id)).toEqual({ projectId: game.id });
    expect(runtime.projects.get(game.id)?.members).toEqual(['default']);

    expect(runtime.renameSession('orphan', 'renamed')).toBe(true);
    expect(runtime.projects.sessionProject('renamed')?.projectId).toBe(game.id);
    expect(runtime.deleteSession('renamed')).toBe(true);
    expect(runtime.projects.get(game.id)?.sessionCount).toBe(0);
  });

  it("hides project replies from a profile's contact-list preview", async () => {
    const { runtime, sessions } = setup();
    await sessions.appendExchange('own', 'dev_test', 'q', 'Own answer');
    await sessions.appendExchange('shared', 'dev_test', 'q', 'Project answer');
    runtime.projects.moveSession('shared', runtime.projects.create({ name: 'P', lead: 'default' }).id);
    expect(runtime.listProfiles().find(profile => profile.name === 'dev_test')?.preview).toBe('Own answer');
  });

  it('follows profile renames and deletes, and refuses to delete a Lead', async () => {
    const { runtime, sessions } = setup();
    await sessions.appendExchange('s1', 'dev_test', 'which engine?', 'Godot.');
    const game = runtime.projects.create({ name: 'Game', lead: 'dev_test', members: ['painter'] });
    runtime.projects.moveSession('s1', game.id);
    runtime.projects.assets.save(game.id, { name: 'a.md', data: Buffer.from('a'), mediaType: 'text/markdown', savedBy: 'dev_test' });

    await runtime.renameProfile('dev_test', 'tester');
    expect(runtime.projects.get(game.id)).toMatchObject({ lead: 'tester', members: ['tester', 'painter'] });
    expect(runtime.projects.assets.find(game.id, 'a.md')?.savedBy).toBe('tester');
    expect(runtime.projects.sessionProject('s1')?.floor).toBe('tester');
    expect(runtime.getSession('s1')?.projectId).toBe(game.id);

    expect(() => runtime.deleteProfile('tester')).toThrow(/leads 'Game'/);
    runtime.deleteProfile('painter');
    expect(runtime.projects.get(game.id)?.members).toEqual(['tester']);
  });

  it('refuses profile names a workspace device answers to', async () => {
    const { runtime } = setup(() => ['Office', 'dev-id-1']);
    expect(() => runtime.initProfile('office')).toThrow(/device in this workspace is named 'office'/);
    await expect(runtime.renameProfile('painter', 'dev-id-1')).rejects.toThrow(/ambiguous/);
    expect(runtime.initProfile('studio').name).toBe('studio');
  });

  it('stores a project icon beside the database and removes it with the project', () => {
    const { runtime, dir } = setup();
    const game = runtime.projects.create({ name: 'Game', lead: 'default' });
    expect(game.icon).toBeUndefined();
    expect(() => runtime.projects.setIcon(game.id, Buffer.from('gif'), 'image/gif')).toThrow(/Unsupported icon type/);
    expect(runtime.projects.setIcon(game.id, Buffer.from('png'), 'image/png').icon).toEqual({ mediaType: 'image/png' });
    expect(runtime.projects.setIcon(game.id, Buffer.from('webp'), 'image/webp').icon).toEqual({ mediaType: 'image/webp' });
    const stored = runtime.projects.icon(game.id)!;
    expect(stored.path).toBe(path.join(dir, 'projects', game.id, 'icon.webp'));
    expect(fs.readdirSync(path.dirname(stored.path))).toEqual(['icon.webp']);
    expect(runtime.projects.list()[0]?.icon).toEqual({ mediaType: 'image/webp' });
    expect(runtime.projects.icon('../proj_1')).toBeUndefined();
    runtime.projects.delete(game.id);
    expect(fs.existsSync(path.dirname(stored.path))).toBe(false);
  });

  it('reads an empty project list before the sessions database exists', () => {
    const { runtime } = setup();
    expect(runtime.projects.list()).toEqual([]);
    expect(runtime.projects.sessionProject('s1')).toBeUndefined();
  });
});
