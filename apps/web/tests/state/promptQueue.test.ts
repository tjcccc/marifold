import { describe, expect, it } from 'vitest';
import { joinQueued, settleQueue, type QueuedPrompt } from '../../src/state/promptQueue';
import { emptyCard } from '../../src/state/threadItems';
import { createThreadState, type ThreadState } from '../../src/state/thread';

function threadWith(steering: string[], status: 'running' | 'completed' | 'cancelled' = 'running'): ThreadState {
  return { ...createThreadState(), items: [{ id: 'r', kind: 'run', run: { ...emptyCard('run_1'), steering, status } }] };
}

describe('prompt queue', () => {
  const queued: QueuedPrompt[] = [
    { id: 'a', text: 'shorter', runId: 'run_1', baseline: 1 },
    { id: 'b', text: 'shorter', runId: 'run_1', baseline: 1 },
    { id: 'c', text: 'after the reply' },
  ];

  it('drops guidance once its run reads it, counting only steering queued after it', () => {
    // "shorter" at index 0 predates the queue; one new read removes one entry.
    expect(settleQueue(queued, threadWith(['shorter'])).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(settleQueue(queued, threadWith(['shorter', 'shorter'])).map(item => item.id)).toEqual(['b', 'c']);
    expect(settleQueue(queued, threadWith(['shorter', 'shorter', 'shorter'])).map(item => item.id)).toEqual(['c']);
  });

  it('keeps what an ended run never read as the next message, and joins it in order', () => {
    const settled = settleQueue(queued, threadWith(['shorter', 'shorter'], 'cancelled'));
    expect(settled).toEqual([{ id: 'b', text: 'shorter' }, { id: 'c', text: 'after the reply' }]);
    expect(joinQueued(settled)).toBe('shorter\n\nafter the reply');
  });

  it('returns the same queue when nothing changed', () => {
    expect(settleQueue(queued, threadWith(['shorter']))).toBe(queued);
  });
});
