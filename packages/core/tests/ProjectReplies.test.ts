import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime } from '../src';
import type { MarifoldConfig } from '../src/config/ConfigSchema';
import type { ResponseMetrics } from '../src/sessions/ResponseMetrics';
import { SessionResolver } from '../src/sessions/SessionResolver';

// Several profiles answering one project message: consecutive assistant turns
// through the real runtime, history, compaction, metrics, and regenerate.

const dirs: string[] = [];
const SUMMARY_MARKER = 'compress prior conversation';

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function setup(overrides: Partial<MarifoldConfig['default']> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-replies-'));
  dirs.push(dir);
  const config = {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false, ...overrides },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
  } as MarifoldConfig;
  const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true } });
  for (const name of ['painter', 'dev_test']) { runtime.initProfile(name); }
  return { dir, config, runtime, sessions: new SessionResolver(config.paths.sessionsDb) };
}

/** Ollama-shaped replies with a fixed input size (to trip compaction or not). */
function stubOllama(inputTokens: number): Array<string> {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const isSummary = body.includes(SUMMARY_MARKER);
    return new Response(JSON.stringify({
      message: { content: isSummary ? 'SUMMARY' : 'assistant reply' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: isSummary ? 5 : inputTokens,
      eval_count: 5,
    }) + '\n', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return bodies;
}

async function run(runtime: MarifoldRuntime, dir: string, profile: string, objective: string, extra: { replyToUserTurnIndex?: number; replaceUserTurnIndex?: number } = {}): Promise<string[]> {
  const types: string[] = [];
  for await (const event of runtime.createAgentRunner(profile).run({ objective, profile, sessionId: 'p', cwd: dir, ...extra })) {
    types.push(event.type === 'compaction' ? `compaction:${event.status}` : event.type);
  }
  return types;
}

const metrics = (model: string): ResponseMetrics => ({ mode: 'agent', provider: 'ollama', model, deep: false, startedAt: 't0', finishedAt: 't1', latencyMs: 1 });

describe('several replies to one message', () => {
  it('lets three profiles answer one project message, each seeing the earlier replies, and compacts only between exchanges', async () => {
    const { dir, runtime, sessions } = setup({ maxContextTokens: 100, compactionKeepTurns: 2 });
    const bodies = stubOllama(95);
    try {
      await sessions.appendExchange('p', 'default', 'intro', 'hello');
      runtime.projects.moveSession('p', runtime.projects.create({ name: 'Game', lead: 'default', members: ['painter', 'dev_test'] }).id);

      expect(await run(runtime, dir, 'default', 'which engine?')).toContain('compaction:completed');
      // A cut after default's answer would orphan painter's reply from its prompt.
      expect(await run(runtime, dir, 'painter', 'which engine?', { replyToUserTurnIndex: 1 })).toContain('compaction:skipped');
      expect(await run(runtime, dir, 'dev_test', 'which engine?', { replyToUserTurnIndex: 1 })).toContain('compaction:skipped');

      const third = bodies.at(-1)!;
      expect(third).toContain('Summary of the earlier conversation: SUMMARY');
      expect(third).toContain('## Replies already given to the current message\\n\\ndefault: assistant reply\\n\\npainter: assistant reply');
      expect(third).toContain('You are dev_test. Replies labelled with another profile');
      expect(third).not.toContain('User: which engine?');

      const turns = runtime.getSession('p')!.turns;
      expect(turns.map(turn => [turn.role, turn.speaker])).toEqual([
        ['user', undefined], ['assistant', undefined], ['user', undefined],
        ['assistant', 'default'], ['assistant', 'painter'], ['assistant', 'dev_test'],
      ]);
      expect(turns.slice(3).every(turn => turn.responseMetrics?.model === 'gemma4:e4b')).toBe(true);

      // The next message folds the whole exchange, labelled by speaker.
      expect(await run(runtime, dir, 'default', 'and the art style?')).toContain('compaction:completed');
      const summaryRequest = bodies.filter(body => body.includes(SUMMARY_MARKER)).at(-1)!;
      expect(summaryRequest).toContain('ASSISTANT: (painter) assistant reply');
      expect(summaryRequest).toContain('ASSISTANT: (dev_test) assistant reply');
      expect(runtime.getSession('p')?.summarizedTurns).toBe(6);
    } finally {
      runtime.close();
    }
  });

  it('regenerates a multi-reply message mid-session: its later replies go, replies come back in place, and later exchanges keep their metadata', async () => {
    const { dir, runtime, sessions, config } = setup();
    stubOllama(10);
    try {
      await sessions.appendExchange('p', 'default', 'first', 'A', undefined, metrics('m-a'), 'default');
      expect(sessions.addReply('p', 0, 'B', { responseMetrics: metrics('m-b'), speaker: 'painter' })).toEqual({ userTurnIndex: 0, replyIndex: 1 });
      sessions.addReply('p', 0, 'C', { speaker: 'dev_test' });
      await sessions.appendExchange('p', 'default', 'second', 'D', [{ data: 'aW1n', mediaType: 'image/png' }], metrics('m-d'));
      runtime.projects.moveSession('p', runtime.projects.create({ name: 'Game', lead: 'default', members: ['painter', 'dev_test'] }).id);

      // Painter regenerates the first message; dev_test answers it again.
      await run(runtime, dir, 'painter', 'first, again', { replaceUserTurnIndex: 0 });
      await run(runtime, dir, 'dev_test', 'first, again', { replyToUserTurnIndex: 0 });

      const turns = runtime.getSession('p')!.turns;
      expect(turns.map(turn => [turn.content, turn.speaker, turn.responseMetrics?.model])).toEqual([
        ['first, again', undefined, undefined],
        ['assistant reply', 'painter', 'gemma4:e4b'],
        ['assistant reply', 'dev_test', 'gemma4:e4b'],
        ['second', undefined, undefined],
        ['D', undefined, 'm-d'],
      ]);
      expect(turns[3].attachments).toHaveLength(1);

      await runtime.renameProfile('painter', 'artist');
      expect(runtime.getSession('p')!.turns[1].speaker).toBe('artist');
      // Truncating from the second message keeps the first exchange's replies.
      sessions.truncateFromUserTurn('p', 1);
      await sessions.appendExchange('p', 'default', 'third', 'E');
      expect(runtime.getSession('p')!.turns.map(turn => turn.speaker ?? turn.responseMetrics?.model ?? '-')).toEqual(['-', 'artist', 'dev_test', '-', '-']);

      // An older Marifold reads and writes first replies in the original table.
      const db = new Database(config.paths.sessionsDb, { fileMustExist: true });
      try {
        expect(db.prepare('SELECT user_turn_index AS u FROM marifold_response_metrics WHERE session_id = ?').all('p')).toEqual([{ u: 0 }]);
      } finally {
        db.close();
      }
    } finally {
      runtime.close();
    }
  });
});
