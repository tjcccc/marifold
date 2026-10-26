import { describe, expect, it } from 'vitest';
import { buildHistoryContext, historyBudgetChars, windowTurns } from '../src/agent/AgentHistory';
import { FALLBACK_CONTEXT_WINDOW, ModelWindows, parseCompactAtPercent, parseContextTokens, resolveCompactAtPercent, resolveContextTokens } from '../src/config/ModelWindows';
import { sessionHistory } from '../src/runtime/AgentCompaction';
import { priestCompactionBudget } from '../src/runtime/ProviderEngines';
import type { ProviderModelList } from '../src/config/ProviderInspector';

describe('context budget', () => {
  it('uses the model window for auto or unset, a fixed number as is, and 0 as off', () => {
    expect(resolveContextTokens(undefined, () => 1_000_000)).toBe(1_000_000);
    expect(resolveContextTokens('auto', () => undefined)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextTokens(16000, () => 1_000_000)).toBe(16000);
    expect(resolveContextTokens(0, () => 1_000_000)).toBeUndefined();
  });

  it('parses "auto" or a non-negative token count', () => {
    expect(parseContextTokens('auto', 'x')).toBe('auto');
    expect(parseContextTokens(0, 'x')).toBe(0);
    expect(parseContextTokens(undefined, 'x')).toBeUndefined();
    for (const bad of [-1, 1.5, 'big']) { expect(() => parseContextTokens(bad, 'x')).toThrow(/auto/); }
  });

  it('fetches only reporting providers, in the background, and retries failures later', async () => {
    let now = 0;
    const calls: string[] = [];
    let reachable = false;
    const windows = new ModelWindows(async provider => {
      calls.push(provider);
      return { provider, reachable, models: ['grok-4'], message: '', contextWindows: { 'grok-4': 1_000_000 } } satisfies ProviderModelList;
    }, () => now);
    expect(windows.lookup('bailian', 'qwen')).toBeUndefined();
    expect(windows.lookup('xai', 'grok-4')).toBeUndefined();
    await windows.refresh('xai');
    expect(windows.lookup('xai', 'grok-4')).toBeUndefined();
    expect(calls).toEqual(['xai']);
    now += 11 * 60 * 1000;
    reachable = true;
    await windows.refresh('xai');
    expect(windows.lookup('xai', 'grok-4')).toBe(1_000_000);
    expect(calls).toEqual(['xai', 'xai']);
  });
});

describe('compact_at_percent', () => {
  it('defaults to 90, takes 0 as off, and refuses 1-9 so a typo cannot turn it off', () => {
    expect(resolveCompactAtPercent(undefined)).toBe(90);
    expect(resolveCompactAtPercent(0)).toBeUndefined();
    expect(parseCompactAtPercent(10, 'x')).toBe(10);
    expect(parseCompactAtPercent(100, 'x')).toBe(100);
    for (const bad of [5, 9, 101, 50.5, '90']) { expect(() => parseCompactAtPercent(bad, 'x')).toThrow(/0 \(off\)/); }
  });

  it("moves priest's fixed 80% trigger to the configured percentage", () => {
    // Priest compacts past 0.8 x its budget: 0.8 x 562500 = 450000 = 90% of 500K.
    expect(priestCompactionBudget({ maxContextTokens: 500_000, compactAtPercent: 90 })).toBe(562_500);
    expect(priestCompactionBudget({ maxContextTokens: 500_000, compactAtPercent: undefined })).toBeUndefined();
    expect(priestCompactionBudget({ maxContextTokens: undefined, compactAtPercent: 90 })).toBeUndefined();
  });
});

describe('agent history with a summary', () => {
  const turns = [
    { role: 'user', content: 'one' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'two' }, { role: 'assistant', content: 'a2' },
  ];

  it('replays the summary and only the turns after it, ignoring a summary that no longer fits the session', () => {
    expect(sessionHistory(turns, { summary: 'S', summarizedThrough: 2 })).toEqual([
      { role: 'summary', content: 'S' }, { role: 'user', content: 'two' }, { role: 'assistant', content: 'a2' },
    ]);
    // A truncated session (fewer turns than the summary covers) falls back to raw turns.
    expect(sessionHistory(turns.slice(0, 1), { summary: 'S', summarizedThrough: 2 })).toEqual([{ role: 'user', content: 'one' }]);
  });

  it('keeps the summary through the turn window and the char budget', () => {
    const history = sessionHistory(turns, { summary: 'S', summarizedThrough: 2 });
    expect(windowTurns(history, 1)).toEqual([{ role: 'summary', content: 'S' }, { role: 'assistant', content: 'a2' }]);
    const block = buildHistoryContext(history, 5)!;
    expect(block).toContain('Summary of the earlier conversation: S');
    expect(block).toContain('Assistant: a2');
    expect(block).not.toContain('User: two');
    expect(historyBudgetChars(100_000, 90)).toBe(270_000);
  });
});
