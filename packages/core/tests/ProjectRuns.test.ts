import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime, planProjectTurn, routeProjectMessage } from '../src';
import type { AgentEvent } from '../src/agent/AgentEvents';
import type { MarifoldConfig } from '../src/config/ConfigSchema';
import { withoutProfileMentions } from '../src/projects/ProjectTurns';
import { ProjectTurn } from '../src/runs/ProjectTurn';
import type { RunRegistry, RunStartInput } from '../src/runs/RunRegistry';
import { SessionResolver } from '../src/sessions/SessionResolver';

// Project turns: who answers a message, and the speakers' runs one after
// another on its session (docs/projects.md#who-answers).

const dirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) { cleanup(); }
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-project-runs-'));
  dirs.push(dir);
  const config = {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
  } as MarifoldConfig;
  const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true } });
  for (const name of ['painter', 'dev_test', 'critic']) { runtime.initProfile(name); }
  const registry = runtime.createRunRegistry();
  cleanups.push(() => { registry.close(); runtime.close(); });
  const game = runtime.projects.create({ name: 'Game', lead: 'default', members: ['painter', 'dev_test'] });
  return { dir, runtime, registry, game, sessions: new SessionResolver(config.paths.sessionsDb) };
}

/** Ollama-shaped replies; `status`, `content` and `gate` (a wait before answering) go by the request's ordinal. */
function stubOllama(options: { status?: (call: number) => number; content?: (call: number) => string; gate?: (call: number) => Promise<void> | undefined } = {}): string[] {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const status = options.status?.(bodies.length) ?? 200;
    const gate = options.gate?.(bodies.length);
    if (gate) {
      await Promise.race([gate, new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })]);
    }
    if (status !== 200) { return new Response('{"error":"model crashed"}', { status }); }
    return new Response(JSON.stringify({ message: { content: options.content?.(bodies.length) ?? 'assistant reply' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }) + '\n', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return bodies;
}

function plan(runtime: MarifoldRuntime, input: { sessionId?: string; objective: string; profile?: string; lean?: boolean; replaceUserTurnIndex?: number }, projectId?: string) {
  return planProjectTurn({
    projects: runtime.projects,
    profileNames: () => runtime.listProfiles().map(profile => profile.name),
    sessionExists: sessionId => runtime.getSession(sessionId) !== undefined,
  }, input, projectId);
}

/** Start a run the way the service does in a project session. */
function start(setupResult: ReturnType<typeof setup>, sessionId: string, objective: string, projectId?: string) {
  const input: RunStartInput = { objective, sessionId, cwd: setupResult.dir };
  const project = plan(setupResult.runtime, input, projectId);
  return setupResult.registry.start({ ...input, ...(project ? { projectTurn: project.plan } : {}) });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function drain(registry: RunRegistry, runId: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const { event } of registry.events(runId, 0)) { events.push(event); }
  return events;
}

describe('project turns', () => {
  it('routes to the mentioned roster profiles, else the floor, else the Lead', () => {
    const project = { id: 'proj_1', lead: 'default', members: ['default', 'painter', 'dev_test'] };
    const names = () => ['default', 'painter', 'dev_test', 'critic'];
    expect(routeProjectMessage('which engine?', project, undefined, names)).toEqual({ speakers: ['default'] });
    expect(routeProjectMessage('and the colors?', project, 'painter', names)).toEqual({ speakers: ['painter'] });
    // A floor holder who left the roster hands the floor back to the Lead.
    expect(routeProjectMessage('hi', project, 'critic', names)).toEqual({ speakers: ['default'] });
    expect(routeProjectMessage('@dev_test, which engine?', project, 'painter', names)).toEqual({ speakers: ['dev_test'], floor: 'dev_test' });
    expect(routeProjectMessage('@painter @dev_test @painter compare', project, 'painter', names)).toEqual({ speakers: ['painter', 'dev_test'], floor: null });
    // Other mentions are devices, left for device routing.
    expect(routeProjectMessage('@painter on @office draw', project, undefined, names)).toEqual({ speakers: ['painter'], floor: 'painter' });
    expect(withoutProfileMentions('@painter on @office draw', project.members)).toBe('on @office draw');
    expect(() => routeProjectMessage('@critic thoughts?', project, undefined, names)).toThrow(/'critic' is not on this project's roster/);
  });

  it('joins a new session by project id, refuses an existing ordinary one, keeps a skill to its profile, and leaves the floor on edits', async () => {
    const { runtime, game, sessions } = setup();
    await sessions.appendExchange('plain', 'painter', 'q', 'a');
    expect(() => plan(runtime, { sessionId: 'plain', objective: 'hi' }, game.id)).toThrow(/move it there first/);
    expect(plan(runtime, { sessionId: 'plain', objective: '@painter hi' })).toBeUndefined();

    const fresh = plan(runtime, { sessionId: 'new', objective: '@painter on @office draw' }, game.id)!;
    expect(fresh.plan).toMatchObject({ projectId: game.id, speakers: ['painter'], floor: 'painter', newSession: true });
    expect(fresh.deviceText).toEqual({ objective: 'on @office draw' });
    expect(fresh.plan.instructions.painter![0]).toContain('You are painter, one of its profiles: default (Lead), painter, dev_test.');

    runtime.projects.moveSession('plain', game.id);
    expect(() => plan(runtime, { sessionId: 'plain', objective: 'x', lean: true, profile: 'dev_test' }, game.id)).toThrow(/painter answers here; address @dev_test/);
    expect(plan(runtime, { sessionId: 'plain', objective: '@dev_test again', replaceUserTurnIndex: 0 })!.plan).not.toHaveProperty('floor');
  });

  it('answers one message with each mentioned profile in turn, handing off before done', async () => {
    const context = setup();
    const { runtime, registry, game } = context;
    const memory = '<memory_save>{"memories":[{"kind":"user","text":"The user builds a robot game.","conflict_key":"user.game"}]}</memory_save>';
    const bodies = stubOllama({ content: call => call === 2 ? `assistant reply${memory}` : 'assistant reply' });
    const first = start(context, 'g', '@painter @dev_test which engine?', game.id);
    expect(first).toMatchObject({ profile: 'painter', projectTurn: { projectId: game.id, speakers: ['painter', 'dev_test'], index: 0 } });

    const events = await drain(registry, first.id);
    expect(events.slice(-2).map(event => event.type)).toEqual(['handoff', 'done']);
    const handoff = events.at(-2) as Extract<AgentEvent, { type: 'handoff' }>;
    expect(registry.require(handoff.runId)).toMatchObject({ profile: 'dev_test', sessionId: 'g', projectTurn: { index: 1 } });
    expect((await drain(registry, handoff.runId)).at(-1)).toMatchObject({ type: 'done', status: 'completed' });

    const session = runtime.getSession('g')!;
    expect(session.turns.map(turn => [turn.role, turn.speaker])).toEqual([['user', undefined], ['assistant', 'painter'], ['assistant', 'dev_test']]);
    expect(session).toMatchObject({ projectId: game.id, profileName: 'painter' });
    expect(session.floor).toBeUndefined();
    // dev_test answered the same message, seeing painter's reply.
    expect(bodies.at(-1)).toContain('Replies already given to the current message\\n\\npainter: assistant reply');
    expect(bodies.at(-1)).toContain('You are dev_test, one of its profiles');
    // Each speaker remembers for itself.
    expect(runtime.listMemories('dev_test').map(entry => entry.text)).toEqual(['The user builds a robot game.']);
    expect(runtime.listMemories('painter')).toEqual([]);

    // Several mentions handed the floor back to the Lead.
    const next = start(context, 'g', 'thanks');
    expect(next).toMatchObject({ profile: 'default', projectTurn: { speakers: ['default'] } });
    await drain(registry, next.id);
  });

  it('stops the turn on cancel, but not when a speaker fails', async () => {
    const context = setup();
    const { runtime, registry, game } = context;
    const bodies = stubOllama({ gate: () => new Promise<void>(() => {}) });
    const cancelled = start(context, 'c', '@painter @dev_test which engine?', game.id);
    await waitFor(() => bodies.length > 0);
    registry.cancel(cancelled.id);
    const events = await drain(registry, cancelled.id);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
    expect(events.some(event => event.type === 'handoff')).toBe(false);
    expect(registry.list().filter(run => run.sessionId === 'c')).toHaveLength(1);

    stubOllama({ status: call => call === 1 ? 500 : 200 });
    const failed = start(context, 'f', '@painter @dev_test which engine?', game.id);
    const failedEvents = await drain(registry, failed.id);
    expect(failedEvents.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
    const handoff = failedEvents.find(event => event.type === 'handoff') as Extract<AgentEvent, { type: 'handoff' }>;
    expect((await drain(registry, handoff.runId)).at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(runtime.getSession('f')!.turns.at(-1)).toMatchObject({ role: 'assistant', speaker: 'dev_test' });

    // A regenerated message whose first answer failed keeps its old replies, so nobody adds to them.
    const edit = new ProjectTurn({ projectId: game.id, speakers: ['painter', 'dev_test'], instructions: {} }, { objective: 'x', replaceUserTurnIndex: 0 }, 0);
    expect(edit.continuesAfter(0, 'failed', 1)).toBe(false);
    expect(edit.continuesAfter(0, 'completed', 1)).toBe(true);
  });

  it('holds the session for the whole turn: a client leaving or another device taking over during speaker 1 neither frees it nor stops speaker 2', async () => {
    const context = setup();
    const { runtime, registry, game } = context;
    let release = () => {};
    let calls = 0;
    const bodies = stubOllama({ gate: call => call === calls + 1 ? new Promise<void>(resolve => { release = resolve; }) : undefined });
    const turn = async (sessionId: string, during: () => void) => {
      calls = bodies.length;
      runtime.acquireSession(sessionId, 'web');
      const input: RunStartInput = { objective: '@painter @dev_test which engine?', sessionId, cwd: context.dir, sessionOwner: 'web' };
      const first = registry.start({ ...input, projectTurn: plan(runtime, input, game.id)!.plan });
      await waitFor(() => bodies.length > calls);
      during();
      release();
      const handoff = (await drain(registry, first.id)).find(event => event.type === 'handoff') as Extract<AgentEvent, { type: 'handoff' }>;
      expect((await drain(registry, handoff.runId)).at(-1)).toMatchObject({ type: 'done', status: 'completed' });
      expect(runtime.getSession(sessionId)!.turns.map(entry => entry.speaker ?? entry.role)).toEqual(['user', 'painter', 'dev_test']);
    };

    await turn('t', () => runtime.takeOverSession('t', 'phone'));
    expect(() => runtime.assertSessionAvailable('t', 'web')).toThrow(/in use/);
    expect(() => runtime.assertSessionAvailable('t', 'phone')).not.toThrow();

    // The tab's release waits for the last speaker, then frees the session.
    await turn('r', () => {
      runtime.releaseSession('r', 'web');
      expect(() => runtime.acquireSession('r', 'phone')).toThrow(/in use/);
    });
    expect(() => runtime.assertSessionAvailable('r', 'phone')).not.toThrow();

    // Without a client lease the turn creates one; it is gone once the turn ends.
    const free = start(context, 'n', '@painter @dev_test again', game.id);
    expect(() => runtime.assertSessionAvailable('n', 'web')).toThrow(/in use/);
    await drain(registry, free.id);
    await drain(registry, registry.list().find(run => run.sessionId === 'n' && run.profile === 'dev_test')!.id);
    expect(() => runtime.assertSessionAvailable('n', 'web')).not.toThrow();
  });
});
