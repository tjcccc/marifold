import { describe, expect, it } from 'vitest';
import type { AgentEvent, RunRecord } from '../../src/api/types';
import {
  activeRun,
  createThreadState,
  hasRunActivity,
  isTrivialRun,
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
  pendingUserInputs: [],
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
      {
        type: 'session_loaded',
        turns: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'hello',
            responseMeta: {
              startedAt: '2026-07-27T02:59:58.000Z',
              finishedAt: '2026-07-27T03:00:00.000Z',
              latencyMs: 2_000,
              usage: { totalTokens: 90 },
            },
          },
        ],
      },
      { type: 'user_message', text: 'again' },
      { type: 'chat_started', startedAt: '2026-07-27T03:00:00.000Z' },
      { type: 'chat_reasoning', text: 'Check' },
      { type: 'chat_reasoning', text: 'ing.' },
      { type: 'chat_chunk', text: 'wor' },
      { type: 'chat_chunk', text: 'ld' },
    );
    expect(state.items.map(i => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant']);
    expect(state.items[1]).toMatchObject({
      kind: 'assistant',
      responseMeta: { latencyMs: 2_000, usage: { totalTokens: 90 } },
    });
    expect(state.items[3]).toMatchObject({
      kind: 'assistant',
      markdown: 'Reasoning: Checking.',
      runPhase: 'reasoning',
    });
    const streaming = state.items[4];
    expect(streaming).toMatchObject({ kind: 'assistant', markdown: 'world', streaming: true });

    state = reduce(state, {
      type: 'chat_done',
      finishedAt: '2026-07-27T03:00:02.250Z',
      latencyMs: 2250,
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(state.items[4]).toMatchObject({
      streaming: false,
      responseMeta: {
        startedAt: '2026-07-27T03:00:00.000Z',
        finishedAt: '2026-07-27T03:00:02.250Z',
        latencyMs: 2250,
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    });
    expect(state.items[2]).toMatchObject({ kind: 'user', sessionUserTurnIndex: 1 });
  });

  it('replays durable image thumbnails with their user turn', () => {
    const state = reduce(createThreadState('sess-1'), {
      type: 'session_loaded',
      turns: [{
        role: 'user',
        content: 'What is this?',
        attachments: [{ kind: 'image', name: 'Image 1', previewUrl: 'data:image/png;base64,AAA' }],
      }],
    });
    expect(state.items[0]).toMatchObject({
      kind: 'user',
      sessionUserTurnIndex: 0,
      attachments: [{ kind: 'image', name: 'Image 1', previewUrl: 'data:image/png;base64,AAA' }],
    });
  });

  it('regenerates an edited exchange in place while preserving later turns', () => {
    let state = reduce(createThreadState('sess-1'), {
      type: 'session_loaded',
      turns: [
        { role: 'user', content: 'Conversation 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Conversation 2' },
        { role: 'assistant', content: 'Answer 2' },
        { role: 'user', content: 'Conversation 3' },
        { role: 'assistant', content: 'Answer 3' },
      ],
    });
    const target = state.items.find(item => item.kind === 'user' && item.text === 'Conversation 2');
    if (!target) throw new Error('missing editable turn');

    state = reduce(
      state,
      { type: 'edit_user_message', itemId: target.id, text: 'Updated conversation 2' },
      { type: 'run_created', run: { ...record, objective: 'Updated conversation 2' } },
      ...runEvents('run_1', [
        { type: 'text', text: 'Updated answer 2', phase: 'final' },
        { type: 'done', taskId: 'task_edit', status: 'completed' },
      ]),
    );

    expect(state.items.flatMap(item => {
      if (item.kind === 'user') return [`user:${item.text}`];
      if (item.kind === 'assistant') return [`assistant:${item.markdown}`];
      return [];
    })).toEqual([
      'user:Conversation 1',
      'assistant:Answer 1',
      'user:Updated conversation 2',
      'assistant:Updated answer 2',
      'user:Conversation 3',
      'assistant:Answer 3',
    ]);
    expect(state.items.find(item => item.id === target.id)).toMatchObject({
      kind: 'user',
      sessionUserTurnIndex: 1,
      replacing: undefined,
    });
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
        { type: 'reasoning', summary: 'The notes are the relevant source.' },
        { type: 'text', text: 'I’ll check the notes first.', phase: 'progress' },
        { type: 'tool_request', call: { id: 'c1', tool: 'read_file', kind: 'read', input: {}, summary: 'read notes.md' } },
        { type: 'tool_result', callId: 'c1', tool: 'read_file', summary: 'read 1.2KB', isError: false },
        { type: 'step', taskId: 'task_9', stepId: 's1', text: 'Read', status: 'completed' },
        { type: 'text', text: 'All done.', phase: 'final' },
        { type: 'done', taskId: 'task_9', status: 'completed', summary: 'Done', usage: { inputTokens: 10, outputTokens: 5 } },
      ]),
    );
    const run = card(state);
    expect(run).toMatchObject({
      taskId: 'task_9',
      status: 'completed',
      summary: 'Done',
      collapsed: true,
      lastSeq: 9,
    });
    expect(run.rows).toEqual([
      { callId: 'c1', tool: 'read_file', kind: 'read', summary: 'read 1.2KB', phase: 'done', isError: false },
    ]);
    expect(run.plan?.[0].status).toBe('completed');
    // Progress commentary and the final answer stay distinct so renderers can
    // mute only the former. The previous progress cursor closes immediately.
    const prose = state.items.filter(i => i.kind === 'assistant');
    expect(prose).toHaveLength(3);
    expect(prose[0]).toMatchObject({ markdown: 'Reasoning: The notes are the relevant source.', runId: 'run_1', runPhase: 'reasoning', streaming: false });
    expect(prose[1]).toMatchObject({ markdown: 'I’ll check the notes first.', runId: 'run_1', runPhase: 'progress', streaming: false });
    expect(prose[2]).toMatchObject({ markdown: 'All done.', runId: 'run_1', runPhase: 'final', streaming: false });
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

  it('parks on user-input questions, preserves answers, and clears stale forms', () => {
    const request = {
      id: 'q1',
      questions: [{
        id: 'style',
        question: 'Choose a style.',
        options: [{ id: 'apple', label: 'Apple' }, { id: 'material', label: 'Material' }],
      }],
    };
    const waiting = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      { type: 'run_event', runId: 'run_1', seq: 1, event: { type: 'user_input_request', request } },
    );
    expect(card(waiting).userInput).toEqual(request);
    expect(hasRunActivity(card(waiting))).toBe(true);

    const restored = reduce(createThreadState(), {
      type: 'run_created',
      run: { ...record, pendingUserInputs: [request] },
    });
    expect(card(restored).userInput).toEqual(request);

    const busy = reduce(waiting, { type: 'user_input_submitting', runId: 'run_1' });
    expect(card(busy).userInputBusy).toBe(true);
    const answered = reduce(busy, {
      type: 'run_event',
      runId: 'run_1',
      seq: 2,
      event: {
        type: 'user_input_response',
        response: { requestId: 'q1', answers: [{ questionId: 'style', optionId: 'apple', value: 'Apple' }] },
      },
    });
    expect(card(answered).userInput).toBeUndefined();
    expect(card(answered).userInputBusy).toBe(false);
    expect(card(answered).inputResponses[0]).toMatchObject({
      request,
      response: { answers: [{ value: 'Apple' }] },
    });

    const failed = reduce(waiting, {
      type: 'user_input_failed',
      runId: 'run_1',
      gone: true,
      message: 'Already answered.',
    });
    expect(card(failed).userInput).toBeUndefined();
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

  it('user messages carry attachment summaries for the bubble', () => {
    const state = reduce(createThreadState(), {
      type: 'user_message',
      text: 'What is this?',
      attachments: [{ kind: 'image', name: 'shot.png', previewUrl: 'data:image/png;base64,AAA' }],
    });
    expect(state.items[0]).toMatchObject({
      kind: 'user',
      text: 'What is this?',
      attachments: [{ kind: 'image', name: 'shot.png' }],
    });
    // Empty lists stay off the item entirely.
    const bare = reduce(createThreadState(), { type: 'user_message', text: 'hi', attachments: [] });
    expect('attachments' in bare.items[0]).toBe(false);
  });

  it('discards a cancelled UI branch before an edited prompt is resent', () => {
    const state = reduce(
      createThreadState(),
      { type: 'user_message', text: 'Earlier prompt' },
      { type: 'run_created', run: { ...record, status: 'completed' } },
      { type: 'user_message', text: 'Mistyped prompt' },
      { type: 'run_created', run: { ...record, id: 'run_2', status: 'cancelled' } },
      { type: 'notice', tone: 'info', text: 'cancelled' },
    );
    const editedItem = state.items.find(item => item.kind === 'user' && item.text === 'Mistyped prompt');
    if (!editedItem) throw new Error('missing edited user item');

    const discarded = reduce(state, { type: 'discard_from', itemId: editedItem.id });

    expect(discarded.items.map(item => item.kind)).toEqual(['user', 'run']);
    expect(discarded.items.some(item => item.kind === 'user' && item.text === 'Mistyped prompt')).toBe(false);
    expect(discarded.discardedRunIds).toEqual(['run_2']);
    const caughtUp = reduce(discarded, {
      type: 'catch_up',
      runs: [{ ...record, id: 'run_2', status: 'cancelled' }],
    });
    expect(caughtUp.catchUp).toEqual([]);
  });

  it('assigns durable user-turn ordinals only to successfully completed attempts', () => {
    let state = reduce(
      createThreadState(),
      { type: 'user_message', text: 'Cancelled prompt' },
      { type: 'run_created', run: record },
      ...runEvents('run_1', [{ type: 'done', taskId: 't1', status: 'cancelled' }]),
      { type: 'user_message', text: 'Completed prompt' },
      { type: 'run_created', run: { ...record, id: 'run_2' } },
      ...runEvents('run_2', [{ type: 'done', taskId: 't2', status: 'completed' }]),
    );
    const users = state.items.filter(
      (item): item is Extract<ThreadState['items'][number], { kind: 'user' }> => item.kind === 'user',
    );
    expect(users[0].sessionUserTurnIndex).toBeUndefined();
    expect(users[1].sessionUserTurnIndex).toBe(0);
  });

  it('classifies trivial runs: completed without activity, never failed ones', () => {
    // A run that only produced text and finished — nothing card-worthy.
    let state = reduce(
      createThreadState(),
      { type: 'run_created', run: record },
      ...runEvents('run_1', [
        { type: 'text', text: 'All done.' },
        { type: 'done', taskId: 't1', status: 'completed', usage: { totalTokens: 512 } },
      ]),
    );
    expect(hasRunActivity(card(state))).toBe(false);
    expect(isTrivialRun(card(state))).toBe(true);

    // The same shape ending in failure keeps its card.
    state = reduce(
      createThreadState(),
      { type: 'run_created', run: { ...record, id: 'run_2' } },
      ...runEvents('run_2', [{ type: 'done', taskId: 't2', status: 'failed' }]),
    );
    expect(isTrivialRun(card(state, 'run_2'))).toBe(false);

    // A tool call makes the run card-worthy even when completed.
    state = reduce(
      createThreadState(),
      { type: 'run_created', run: { ...record, id: 'run_3' } },
      ...runEvents('run_3', [
        {
          type: 'tool_request',
          call: { id: 'c1', tool: 'write_file', kind: 'write', summary: 'write note.md', input: {} },
        },
        { type: 'tool_result', callId: 'c1', tool: 'write_file', summary: 'wrote note.md', isError: false },
        { type: 'done', taskId: 't3', status: 'completed' },
      ]),
    );
    expect(hasRunActivity(card(state, 'run_3'))).toBe(true);
    expect(isTrivialRun(card(state, 'run_3'))).toBe(false);

    // A pending approval always shows the card.
    state = reduce(
      createThreadState(),
      { type: 'run_created', run: { ...record, id: 'run_4' } },
      ...runEvents('run_4', [
        {
          type: 'approval_request',
          request: { id: 'c9', tool: 'write_file', kind: 'write', summary: 'write x', input: {}, escalated: false },
        },
      ]),
    );
    expect(hasRunActivity(card(state, 'run_4'))).toBe(true);
  });
});
