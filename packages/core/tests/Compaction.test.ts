import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { COMPACTION_METADATA_KEY } from '@priest-ai/core';
import { MarifoldRuntime } from '../src';
import { MarifoldConfig } from '../src/config/ConfigSchema';

// End-to-end compaction through the *real* MarifoldRuntime.stream — the path no
// priest unit test can cover, because the feature's state lives in session
// metadata and marifold runs its own session-write helpers (replaceLastAssistantTurn,
// applyTurnMemory) against the same DB. This proves the metadata round-trip,
// the budget trigger, and persistence together.

const tempDirs: string[] = [];
const SUMMARY_MARKER = 'compress prior conversation';

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeConfig(
  dir: string,
  overrides: Partial<MarifoldConfig['default']> = {},
  extra: Partial<MarifoldConfig> = {},
): MarifoldConfig {
  return {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false, ...overrides },
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
      // No profile.toml override → profile-level is undefined (global default is
      // applied later in toPriestConfig, not here).
      expect(runtime.resolveSettings({}).maxContextTokens).toBeUndefined();
      // A session-scoped override wins.
      expect(runtime.resolveSettings({ maxContextTokens: 50 }).maxContextTokens).toBe(50);
    } finally {
      runtime.close();
    }
  });

  it('does not compact when no budget is configured (backward compatible)', async () => {
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
