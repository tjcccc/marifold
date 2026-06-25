import { describe, expect, it } from 'vitest';
import { buildHistoryContext } from '../src/agent/AgentHistory';

describe('buildHistoryContext', () => {
  it('returns undefined for empty turns or a non-positive budget', () => {
    expect(buildHistoryContext([], 1000)).toBeUndefined();
    expect(buildHistoryContext([{ role: 'user', content: 'x' }], 0)).toBeUndefined();
  });

  it('formats recent turns as a labeled block', () => {
    const block = buildHistoryContext([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ], 1000)!;
    expect(block).toContain('## Earlier in this conversation');
    expect(block).toContain('User: hi');
    expect(block).toContain('Assistant: hello');
  });

  it('keeps only the most recent turns within the char budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `turn-${i}-${'x'.repeat(40)}` }));
    const block = buildHistoryContext(turns, 120)!;
    expect(block).toContain('turn-9');      // most recent kept
    expect(block).not.toContain('turn-0');  // oldest dropped
  });

  it('always keeps at least the single most recent turn even if it exceeds budget', () => {
    const block = buildHistoryContext([{ role: 'assistant', content: 'x'.repeat(500) }], 10)!;
    expect(block).toContain('x'.repeat(500));
  });
});
