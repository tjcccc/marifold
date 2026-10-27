import type { ThreadState } from './threadTypes';
import { findRunItem } from './threadItems';

/** A prompt typed while a reply was in progress. With `runId` it is guidance
 * queued on that run, waiting for the agent's next step; without, it waits to
 * go out as the next message. */
export interface QueuedPrompt {
  id: string;
  text: string;
  runId?: string;
  /** The service's id for the queued note, to withdraw it. */
  steeringId?: string;
  /** The run's steering count when this was queued: later entries can be it. */
  baseline?: number;
}

/** Drop the prompts their run has read (they show in its card as guidance)
 * and keep those whose run ended without reading them as the next message. */
export function settleQueue(queue: QueuedPrompt[], thread: ThreadState): QueuedPrompt[] {
  const cursors = new Map<string, number>();
  let changed = false;
  const next: QueuedPrompt[] = [];
  for (const item of queue) {
    const card = item.runId ? findRunItem(thread, item.runId)?.run : undefined;
    if (!item.runId || !card) {
      next.push(item);
      continue;
    }
    const from = Math.max(item.baseline ?? 0, cursors.get(item.runId) ?? 0);
    const read = card.steering.indexOf(item.text, from);
    if (read !== -1) {
      cursors.set(item.runId, read + 1);
      changed = true;
    } else if (card.status !== 'running') {
      next.push({ id: item.id, text: item.text });
      changed = true;
    } else {
      next.push(item);
    }
  }
  return changed ? next : queue;
}

/** Leftover prompts go out together, in the order they were typed. */
export function joinQueued(queue: QueuedPrompt[]): string {
  return queue.map(item => item.text).join('\n\n');
}
