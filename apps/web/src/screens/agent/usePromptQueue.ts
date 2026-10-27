import { useCallback, useEffect, useRef, useState } from 'react';
import { MarifoldApiError, type ApiClient } from '../../api/client';
import { steerRun, withdrawSteering } from '../../api/runs';
import { joinQueued, settleQueue, type QueuedPrompt } from '../../state/promptQueue';
import { findRunItem } from '../../state/threadItems';
import type { ThreadState } from '../../state/thread';

export interface PromptQueue {
  queued: QueuedPrompt[];
  /** Queue on `runId` as guidance, or for the next message without one. */
  enqueue: (text: string, runId?: string) => Promise<boolean>;
  withdraw: (id: string) => void;
}

let nextId = 0;

/** Prompts typed while a reply is in progress. Guidance queued on a run leaves
 * the queue once the agent reads it; what no run read goes out as one message
 * when the session is idle again. */
export function usePromptQueue(
  client: ApiClient,
  thread: ThreadState,
  busy: boolean,
  send: (text: string) => Promise<boolean>,
  onError: (error: unknown) => void,
): PromptQueue {
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const sendRef = useRef(send);
  sendRef.current = send;
  const flushing = useRef(false);

  useEffect(() => { setQueued([]); }, [thread.sessionId]);

  useEffect(() => {
    setQueued(current => settleQueue(current, thread));
  }, [thread, queued]);

  useEffect(() => {
    if (busy || flushing.current || queued.length === 0 || queued.some(item => item.runId)) { return; }
    flushing.current = true;
    setQueued([]);
    void sendRef.current(joinQueued(queued)).finally(() => { flushing.current = false; });
  }, [busy, queued]);

  const enqueue = useCallback(async (text: string, runId?: string): Promise<boolean> => {
    const id = `queued_${++nextId}`;
    if (!runId) {
      setQueued(current => [...current, { id, text }]);
      return true;
    }
    const baseline = findRunItem(threadRef.current, runId)?.run.steering.length ?? 0;
    try {
      const steeringId = await steerRun(client, runId, text);
      setQueued(current => [...current, { id, text, runId, baseline, ...(steeringId ? { steeringId } : {}) }]);
    } catch (error) {
      // The run ended while this was typed: it becomes the next message.
      if (error instanceof MarifoldApiError && (error.code === 'AGENT_RUN_INVALID' || error.code === 'RUN_NOT_FOUND')) {
        setQueued(current => [...current, { id, text }]);
        return true;
      }
      onError(error);
      return false;
    }
    return true;
  }, [client, onError]);

  const withdraw = useCallback((id: string) => {
    const item = queued.find(entry => entry.id === id);
    if (!item) { return; }
    if (!item.runId || !item.steeringId) {
      setQueued(current => current.filter(entry => entry.id !== id));
      return;
    }
    // Once the agent has read it, it stays: the run card shows it as guidance.
    void withdrawSteering(client, item.runId, item.steeringId).then(
      withdrawn => { if (withdrawn) { setQueued(current => current.filter(entry => entry.id !== id)); } },
      onError,
    );
  }, [client, queued, onError]);

  return { queued, enqueue, withdraw };
}
