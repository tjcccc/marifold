import { describe, expect, it } from 'vitest';
import type { AgentEvent, RunRecord } from '../../src/api/types';
import {
  activeRun,
  createThreadState,
  threadReducer,
  type ThreadAction,
  type ThreadState,
} from '../../src/state/thread';

function reduce(state: ThreadState, ...actions: ThreadAction[]): ThreadState {
  return actions.reduce(threadReducer, state);
}

function runEvents(runId: string, events: AgentEvent[], startSeq = 1): ThreadAction[] {
  return events.map((event, index) => ({ type: 'run_event', runId, seq: startSeq + index, event }));
}

const record: RunRecord = {
  id: 'run_1',
  objective: 'Write a note.',
  profile: 'default',
  status: 'running',
  createdAt: '2026-07-05T10:00:00.000Z',
  eventCount: 0,
  pendingApprovals: [],
};

function card(state: ThreadState, runId = 'run_1') {
  const item = state.items.find(i => i.kind === 'run' && i.run.runId === runId);
  if (!item || item.kind !== 'run') throw new Error(`no run card for ${runId}`);
  return item.run;
}

describe('threadReducer', () => {
  it('replays session turns and appends chat streaming turns', () => {
    let state = reduce(
      createThreadState('sess-1'),
      { type: 'session_loaded', turns: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
      { type: 'user_message', text: 'again' },
      { type: 'chat_started' },
      { type: 'chat_chunk', text: 'wor' },
      { type: 'chat_chunk', text: 'ld' },
    );
    expect(state.items.map(i => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const streaming = state.items[3];
    expect(streaming).toMatchObject({ kind: 'assistant', markdown: 'world', streaming: true });

    state = reduce(state, { type: 'chat_done' });
    expect(state.items[3]).toMatchObject({ streaming: false });
  });

  it('chat errors close the streaming turn and add a notice', () => {
    const state = reduce(
      createThreadState(),
      { type: 'chat_started' },
      { type: 'chat_chunk', text: 'par' },
      { type: 'chat_error', message: 'boom' },
    );
    expect(state.items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(state.items[1]).toMatchObject({ kind: 'notice', tone: 'error', text: 'boom' });
  });

  it('groups a full run into a card: plan, tool fold, text, footer', () => {
    const state = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      ...runEvents('run_1', [
        { type: 'status', taskId: 'task_9', status: 'running' },
        { type: 'plan', taskId: 'task_9', plan: [{ id: 's1', text: 'Read', status: 'in_progress', createdAt: '', updatedAt: '' }] },
        { type: 'tool_request', call: { id: 'c1', tool: 'read_file', kind: 'read', input: {}, summary: 'read notes.md' } },
        { type: 'tool_result', callId: 'c1', tool: 'read_file', summary: 'read 1.2KB', isError: false },
        { type: 'step', taskId: 'task_9', stepId: 's1', text: 'Read', status: 'completed' },
        { type: 'text', text: 'All done.' },
        { type: 'done', taskId: 'task_9', status: 'completed', summary: 'Done', usage: { inputTokens: 10, outputTokens: 5 } },
      ]),
    );
    const run = card(state);
    expect(run).toMatchObject({
      taskId: 'task_9',
      status: 'completed',
      summary: 'Done',
      collapsed: true,
      lastSeq: 7,
    });
    expect(run.rows).toEqual([
      { callId: 'c1', tool: 'read_file', kind: 'read', summary: 'read 1.2KB', phase: 'done', isError: false },
    ]);
    expect(run.plan?.[0].status).toBe('completed');
    // The run's prose is a normal assistant item bound to the run.
    const prose = state.items.find(i => i.kind === 'assistant');
    expect(prose).toMatchObject({ markdown: 'All done.', runId: 'run_1', streaming: false });
  });

  it('drops replayed events with seq <= lastSeq', () => {
    const base = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      ...runEvents('run_1', [{ type: 'status', taskId: 't', status: 'running' }, { type: 'text', text: 'once' }]),
    );
    const replayed = reduce(base, {
      type: 'run_event',
      runId: 'run_1',
      seq: 2,
      event: { type: 'text', text: 'once' },
    });
    expect(replayed).toBe(base);
  });

  it('raises and clears the approval sheet, recording denials', () => {
    const approvalUp = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      ...runEvents('run_1', [
        {
          type: 'approval_request',
          request: { id: 'c1', tool: 'write_file', kind: 'write', summary: 'write x', input: {}, escalated: false },
        },
      ]),
    );
    expect(card(approvalUp).approval?.id).toBe('c1');
    expect(activeRun(approvalUp)?.runId).toBe('run_1');

    const busy = reduce(approvalUp, { type: 'approval_submitting', runId: 'run_1' });
    expect(card(busy).approvalBusy).toBe(true);

    const denied = reduce(busy, {
      type: 'run_event',
      runId: 'run_1',
      seq: 2,
      event: { type: 'approval_decision', requestId: 'c1', approved: false, source: 'user', reason: 'denied via service' },
    });
    expect(card(denied).approval).toBeUndefined();
    expect(card(denied).approvalBusy).toBe(false);
    expect(card(denied).denials).toEqual(['denied via service']);
  });

  it('steering events append pills; unknown event types are no-ops that advance lastSeq', () => {
    const state = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      ...runEvents('run_1', [
        { type: 'steering', taskId: 't', text: 'shorter please' },
        { type: 'someday_new_event' } as unknown as AgentEvent,
        { type: 'text', text: 'ok' },
      ]),
    );
    expect(card(state).steering).toEqual(['shorter please']);
    expect(card(state).lastSeq).toBe(3);
  });

  it('auto-creates a card for events of an unknown run (cross-client discovery)', () => {
    const state = reduce(createThreadState(), {
      type: 'run_event',
      runId: 'run_elsewhere',
      seq: 1,
      event: { type: 'status', taskId: 't2', status: 'running' },
    });
    expect(card(state, 'run_elsewhere').taskId).toBe('t2');
  });

  it('run_lost marks a running card failed and posts a notice', () => {
    const state = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      { type: 'run_lost', runId: 'run_1' },
    );
    expect(card(state).status).toBe('failed');
    expect(state.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'warn' });
  });

  it('catch_up collects only unseen runs and dismisses wholesale', () => {
    const finished: RunRecord = { ...record, id: 'run_2', status: 'completed' };
    let state = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      { type: 'catch_up', runs: [{ ...record }, finished] },
    );
    expect(state.catchUp.map(r => r.id)).toEqual(['run_2']); // run_1 already in thread
    state = reduce(state, { type: 'catch_up', runs: [finished] });
    expect(state.catchUp).toHaveLength(1); // dedup
    state = reduce(state, { type: 'dismiss_catch_up' });
    expect(state.catchUp).toEqual([]);
  });

  it('toggle_run_details flips collapsed', () => {
    const state = reduce(
      createThreadState(),
      { type: 'run_created', run: { ...record, status: 'completed' } },
      { type: 'toggle_run_details', runId: 'run_1' },
    );
    expect(card(state).collapsed).toBe(false);
  });
});
