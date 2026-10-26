import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { COMPACTION_METADATA_KEY } from '@priest-ai/core';
import { MarifoldRuntime } from '../src';
import type { MarifoldConfig } from '../src/config/ConfigSchema';

// End-to-end compaction through the *real* MarifoldRuntime.stream — the path no
// priest unit test can cover, because the feature's state lives in session
// metadata and marifold runs its own session-write helpers (replaceLastAssistantTurn,
// applyTurnMemory) against the same DB. This proves the metadata round-trip,
// the budget trigger, and persistence together.

const tempDirs: string[] = [];
const SUMMARY_MARKER = 'compress prior conversation';

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeConfig(
  dir: string,
  overrides: Partial<MarifoldConfig['default']> = {},
  extra: Partial<MarifoldConfig> = {},
): MarifoldConfig {
  return {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false, ...overrides },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    ...extra,
  } as MarifoldConfig;
}

/** Ollama-shaped reply. Reports a high input size on chat turns to trip the
 *  budget; returns a short summary on the Compactor's summarization call. */
function stubOllama(inputTokens: number): void {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
    const isSummary = typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.includes(SUMMARY_MARKER);
    // Newline-terminated: ollama's streaming parser is line-delimited and the
    // chat path streams (the `complete` path would tolerate no newline).
    return new Response(JSON.stringify({
      message: { content: isSummary ? 'SUMMARY' : 'assistant reply' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: isSummary ? 5 : inputTokens,
      eval_count: 5,
    }) + '\n', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function runtimeFor(dir: string, config: MarifoldConfig): MarifoldRuntime {
  return new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true } });
}

async function drain(gen: AsyncGenerator<string, void, unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

function readCompaction(sessionsDb: string, id: string): { summary?: string; summarizedThrough?: number; lastInputTokens?: number } {
  const db = new Database(sessionsDb, { fileMustExist: true });
  try {
    const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(id) as { metadata: string } | undefined;
    const meta = row ? JSON.parse(row.metadata) : {};
    return meta[COMPACTION_METADATA_KEY] ?? {};
  } finally {
    db.close();
  }
}

describe('MarifoldRuntime conversation compaction (end-to-end)', () => {
  it('compacts an over-budget chat session and the summary survives marifold session writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-compaction-'));
    tempDirs.push(dir);
    stubOllama(200);
    const config = makeConfig(dir, { maxContextTokens: 100, compactionKeepTurns: 2 });
    const runtime = runtimeFor(dir, config);

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await drain(runtime.stream({ prompt, sessionId: 's' }));
    }
    // Close first so priest's WAL is checkpointed before this fresh connection reads.
    runtime.close();

    const compaction = readCompaction(config.paths.sessionsDb, 's');
    expect(compaction.summary).toBe('SUMMARY');
    expect(compaction.summarizedThrough).toBeGreaterThan(0);
    // Survives the parallel replaceLastAssistantTurn / applyTurnMemory writes.
    expect(compaction.lastInputTokens).toBe(200);
  });

  it('compacts even with web_search enabled when no tool is invoked (the x-runner case)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-compaction-web-'));
    tempDirs.push(dir);
    stubOllama(200); // model returns plain content — never a tool call
    const config = makeConfig(dir, { maxContextTokens: 100, compactionKeepTurns: 2 }, { webSearch: { enabled: true } } as Partial<MarifoldConfig>);
    const runtime = runtimeFor(dir, config);

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await drain(runtime.stream({ prompt, sessionId: 's' }));
    }
    runtime.close();
    expect(readCompaction(config.paths.sessionsDb, 's').summary).toBe('SUMMARY');
  });

  it('resolveSettings lets a request budget override the profile-level value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-compaction-budget-'));
    tempDirs.push(dir);
    const runtime = runtimeFor(dir, makeConfig(dir, { maxContextTokens: 100 }));
    try {
      // No profile.toml override → the global budget applies.
      expect(runtime.resolveSettings({}).maxContextTokens).toBe(100);
      // 0 turns compaction off.
      expect(runtime.resolveSettings({ maxContextTokens: 0 }).maxContextTokens).toBeUndefined();
      // A session-scoped override wins.
      expect(runtime.resolveSettings({ maxContextTokens: 50 }).maxContextTokens).toBe(50);
    } finally {
      runtime.close();
    }
  });

  it('does not compact while far below the auto budget (unset = the model window, 128K for Ollama)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-compaction-off-'));
    tempDirs.push(dir);
    stubOllama(200);
    const runtime = runtimeFor(dir, makeConfig(dir));

    for (const prompt of ['msg1', 'msg2', 'msg3']) {
      await drain(runtime.stream({ prompt, sessionId: 's' }));
    }
    runtime.close();
    expect(readCompaction(path.join(dir, 'sessions.db'), 's').summary).toBeUndefined();
  });
});

describe('agent-mode compaction', () => {
  it('summarizes older agent turns past compact_at_percent without rewriting turns, and replays the summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-compaction-'));
    tempDirs.push(dir);
    // 95 input tokens on a 100-token budget: past the default 90%.
    stubOllama(95);
    const config = makeConfig(dir, { maxContextTokens: 100, compactionKeepTurns: 2 });
    const runtime = runtimeFor(dir, config);
    const run = async (objective: string) => {
      const types: string[] = [];
      for await (const event of runtime.createAgentRunner('default').run({ objective, sessionId: 'a', cwd: dir })) {
        types.push(event.type === 'compaction' ? `compaction:${event.status}` : event.type);
      }
      return types;
    };
    const turnIds = () => {
      const db = new Database(config.paths.sessionsDb, { fileMustExist: true });
      try { return (db.prepare('SELECT id FROM turns WHERE session_id = ? ORDER BY id').all('a') as Array<{ id: number }>).map(row => row.id); } finally { db.close(); }
    };
    try {
      // Two turns are all kept verbatim: nothing to fold yet.
      expect(await run('first')).toContain('compaction:skipped');
      // Compacted inline, before the run reports done.
      const events = await run('second');
      expect(events.slice(-4)).toEqual(['compaction:running', 'compaction:completed', 'status', 'done']);
      const before = turnIds();
      expect(readCompaction(config.paths.sessionsDb, 'a').summary).toBe('SUMMARY');
      expect(readCompaction(config.paths.sessionsDb, 'a').summarizedThrough).toBe(2);
      // Only metadata changed: turn rows keep their ids.
      expect(turnIds().slice(0, before.length)).toEqual(before);
      const requests = (fetch as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls;
      const callsBefore = requests.length;
      await run('third');
      const next = String(requests[callsBefore][1].body);
      expect(next).toContain('Summary of the earlier conversation: SUMMARY');
      expect(next).not.toContain('User: first');
    } finally {
      runtime.close();
    }
  });

  it('compacts against a session budget passed with the run (/context-window set), not the profile budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-compaction-session-'));
    tempDirs.push(dir);
    stubOllama(95);
    const config = makeConfig(dir, { maxContextTokens: 1_000_000, compactionKeepTurns: 2 });
    const runtime = runtimeFor(dir, config);
    try {
      for (const objective of ['first', 'second']) {
        for await (const _ of runtime.createAgentRunner('default').run({ objective, sessionId: 'a', cwd: dir, maxContextTokens: 100 })) { /* consume */ }
      }
      await vi.waitFor(() => expect(readCompaction(config.paths.sessionsDb, 'a').summary).toBe('SUMMARY'));
      expect(runtime.getSession('a')?.summarizedTurns).toBe(2);
    } finally {
      runtime.close();
    }
  });

  it('leaves agent sessions alone below the threshold or when compaction is off', async () => {
    for (const overrides of [{ maxContextTokens: 1000 }, { maxContextTokens: 100, compactAtPercent: 0 }]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-compaction-off-'));
      tempDirs.push(dir);
      stubOllama(95);
      const config = makeConfig(dir, { ...overrides, compactionKeepTurns: 2 });
      const runtime = runtimeFor(dir, config);
      try {
        for (const objective of ['first', 'second', 'third']) {
          for await (const _ of runtime.createAgentRunner('default').run({ objective, sessionId: 'a', cwd: dir })) { /* consume */ }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(readCompaction(config.paths.sessionsDb, 'a').summary).toBeUndefined();
      } finally {
        runtime.close();
      }
    }
  });
});
