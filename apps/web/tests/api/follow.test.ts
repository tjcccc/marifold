import { describe, expect, it } from 'vitest';
import type { ApiClient, StreamInit } from '../../src/api/client';
import { MarifoldApiError } from '../../src/api/client';
import { followRun } from '../../src/api/runs';
import type { AgentEvent } from '../../src/api/types';

function sseBody(frames: Array<{ id: number; event: AgentEvent }>): Response {
  const text = frames
    .map(({ id, event }) => `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(`retry: 5\n\n${text}`, { status: 200 });
}

/** A fake ApiClient whose stream() pops scripted responses and records the
 * StreamInit of each connection attempt. */
function scriptedClient(script: Array<Response | MarifoldApiError>): {
  client: ApiClient;
  inits: StreamInit[];
} {
  const inits: StreamInit[] = [];
  const client: ApiClient = {
    baseUrl: '',
    request: async () => {
      throw new Error('not used');
    },
    stream: async (_path, init = {}) => {
      inits.push(init);
      const next = script.shift();
      if (!next) throw new TypeError('network gone');
      if (next instanceof MarifoldApiError) throw next;
      return next;
    },
  };
  return { client, inits };
}

const status: AgentEvent = { type: 'status', taskId: 'task_1', status: 'running' };
const text: AgentEvent = { type: 'text', text: 'hello' };
const done: AgentEvent = { type: 'done', taskId: 'task_1', status: 'completed' };

describe('followRun', () => {
  it('yields sequenced events and returns after done', async () => {
    const { client } = scriptedClient([
      sseBody([{ id: 1, event: status }, { id: 2, event: text }, { id: 3, event: done }]),
    ]);
    const seen: number[] = [];
    for await (const { seq, event } of followRun(client, 'run_1')) {
      seen.push(seq);
      if (seq === 3) expect(event.type).toBe('done');
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it('reconnects with last-event-id after a drop and never duplicates a seq', async () => {
    const { client, inits } = scriptedClient([
      sseBody([{ id: 1, event: status }, { id: 2, event: text }]), // ends without done → drop
      sseBody([{ id: 2, event: text }, { id: 3, event: done }]), // server replays seq 2
    ]);
    const seen: number[] = [];
    for await (const { seq } of followRun(client, 'run_1', { retryDelayMs: 1, maxRetryDelayMs: 2 })) {
      seen.push(seq);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(inits[0].lastEventId).toBeUndefined();
    expect(inits[1].lastEventId).toBe('2');
  });

  it('resumes from afterSeq', async () => {
    const { client, inits } = scriptedClient([
      sseBody([{ id: 3, event: done }]),
    ]);
    const seen: number[] = [];
    for await (const { seq } of followRun(client, 'run_1', { afterSeq: 2 })) seen.push(seq);
    expect(seen).toEqual([3]);
    expect(inits[0].lastEventId).toBe('2');
  });

  it('propagates RUN_NOT_FOUND instead of retrying forever', async () => {
    const { client } = scriptedClient([
      new MarifoldApiError(404, { code: 'RUN_NOT_FOUND', message: 'gone' }),
    ]);
    const iterator = followRun(client, 'run_evicted');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('stops cleanly when aborted between attempts', async () => {
    const controller = new AbortController();
    const { client } = scriptedClient([
      sseBody([{ id: 1, event: status }]), // no done → would reconnect
    ]);
    const seen: number[] = [];
    for await (const { seq } of followRun(client, 'run_1', {
      signal: controller.signal,
      retryDelayMs: 1000,
    })) {
      seen.push(seq);
      controller.abort(); // abort while the generator is mid-loop
    }
    expect(seen).toEqual([1]);
  });
});
