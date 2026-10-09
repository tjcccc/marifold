import type { AgentEvent, AgentUsage, RunRecord } from '../api/types';
import type { ResponseMetaState, RunCardState, ThreadItem, ThreadState, UserAttachment } from './threadTypes';
import { append, emptyCard, findRunItem, insert, insertRunCard, markUserPersisted, updateRun } from './threadItems';
import { applyRunEvent } from './runEvents';
export type { ToolRowState, RunCardState, ResponseMetaState, UserAttachment, ThreadItem, ThreadState } from './threadTypes';

/**
 * The conversation model: one thread per session, composed from replayed
 * session turns, live chat streams, and live agent runs (grouped into cards).
 * Pure reducer — no React, no fetch — so every transition is unit-testable.
 */

export type ThreadAction =
  | { type: 'reset'; sessionId?: string }
  | {
      type: 'session_loaded';
      turns: Array<{
        role: 'user' | 'assistant';
        content: string;
        attachments?: UserAttachment[];
        responseMeta?: ResponseMetaState;
      }>;
    }
  | { type: 'user_message'; text: string; attachments?: UserAttachment[] }
  | { type: 'edit_user_message'; itemId: string; text: string; attachments?: UserAttachment[] }
  | { type: 'chat_started'; startedAt?: string }
  | { type: 'chat_reasoning'; text: string }
  | { type: 'chat_chunk'; text: string }
  | { type: 'chat_done'; usage?: AgentUsage; latencyMs?: number; finishedAt?: string }
  | { type: 'chat_cancelled' }
  | { type: 'chat_error'; message: string }
  | { type: 'run_created'; run: RunRecord }
  | { type: 'run_event'; runId: string; seq: number; event: AgentEvent }
  | { type: 'run_lost'; runId: string }
  | { type: 'approval_submitting'; runId: string }
  | { type: 'approval_failed'; runId: string; message: string; gone?: boolean }
  | { type: 'user_input_submitting'; runId: string }
  | { type: 'user_input_failed'; runId: string; message: string; gone?: boolean }
  | { type: 'toggle_run_details'; runId: string }
  | { type: 'catch_up'; runs: RunRecord[] }
  | { type: 'dismiss_catch_up'; runId?: string }
  | { type: 'discard_from'; itemId: string }
  | { type: 'notice'; tone: 'info' | 'warn' | 'error'; text: string };

export function createThreadState(sessionId?: string): ThreadState {
  return { sessionId, items: [], catchUp: [], discardedRunIds: [], seq: 0 };
}

/** True when the run produced something a card must show: tool rows, a plan,
 * steering, denials, errors, or a pending approval. Runs without activity
 * render inline (thinking line / bare prose with a meta suffix) instead. */
export function hasRunActivity(run: RunCardState): boolean {
  return (
    run.rows.length > 0 ||
    (run.plan?.length ?? 0) > 0 ||
    run.steering.length > 0 ||
    run.denials.length > 0 ||
    run.errors.length > 0 ||
    run.artifacts.length > 0 ||
    run.approval !== undefined ||
    run.userInput !== undefined ||
    run.inputResponses.length > 0
  );
}

/** A completed run with no activity — no card at all; its usage renders as an
 * inline suffix on the response prose. Failed/cancelled/blocked runs are never
 * trivial: their status must stay visible even without activity. */
export function isTrivialRun(run: RunCardState): boolean {
  return run.status === 'completed' && !hasRunActivity(run);
}

/** The run a new submission should steer instead of starting a fresh turn. */
export function activeRun(state: ThreadState): RunCardState | undefined {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item.kind === 'run' && item.run.status === 'running') { return item.run; }
  }
  return undefined;
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'reset':
      return createThreadState(action.sessionId);

    case 'session_loaded': {
      let next = { ...state, items: [] as ThreadItem[] };
      let userTurnIndex = 0;
      for (const turn of action.turns) {
        next = append(
          next,
          turn.role === 'user'
            ? {
                kind: 'user',
                text: turn.content,
                sessionUserTurnIndex: userTurnIndex++,
                ...(turn.attachments && turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
              }
            : {
                kind: 'assistant',
                markdown: turn.content,
                ...(turn.responseMeta ? { responseMeta: turn.responseMeta } : {}),
              },
        );
      }
      return next;
    }

    case 'user_message':
      return append(state, {
        kind: 'user',
        text: action.text,
        ...(action.attachments && action.attachments.length > 0 ? { attachments: action.attachments } : {}),
      });

    case 'edit_user_message': {
      const index = state.items.findIndex(item => item.id === action.itemId && item.kind === 'user');
      if (index === -1) { return state; }
      const target = state.items[index] as Extract<ThreadItem, { kind: 'user' }>;
      const nextUserOffset = state.items.slice(index + 1).findIndex(item => item.kind === 'user');
      const suffixIndex = nextUserOffset === -1 ? state.items.length : index + 1 + nextUserOffset;
      const replacedItems = state.items.slice(index + 1, suffixIndex);
      const discardedRunIds = replacedItems.flatMap(item => item.kind === 'run' ? [item.run.runId] : []);
      const edited: Extract<ThreadItem, { kind: 'user' }> = {
        ...target,
        text: action.text,
        replacing: true,
        ...(action.attachments !== undefined ? { attachments: action.attachments } : {}),
      };
      return {
        ...state,
        items: [...state.items.slice(0, index), edited, ...state.items.slice(suffixIndex)],
        discardedRunIds: [...new Set([...state.discardedRunIds, ...discardedRunIds])],
      };
    }

    case 'chat_started': {
      const replacingIndex = state.items.findIndex(item => item.kind === 'user' && item.replacing);
      const assistant = {
        kind: 'assistant' as const,
        markdown: '',
        streaming: true,
        responseMeta: { startedAt: action.startedAt ?? new Date().toISOString() },
      };
      return replacingIndex === -1
        ? append(state, assistant)
        : insert(state, replacingIndex + 1, assistant);
    }

    case 'chat_chunk':
      return updateStreamingAssistant(state, item => ({ ...item, markdown: item.markdown + action.text }));

    case 'chat_reasoning':
      return updateChatReasoning(state, action.text);

    case 'chat_done':
      return markLatestPendingUserPersisted(
        updateStreamingAssistant(state, item => ({
          ...item,
          streaming: false,
          responseMeta: item.responseMeta ? {
            ...item.responseMeta,
            finishedAt: action.finishedAt ?? new Date().toISOString(),
            ...(action.latencyMs !== undefined ? { latencyMs: action.latencyMs } : {}),
            ...(action.usage ? { usage: action.usage } : {}),
          } : undefined,
        })),
      );

    case 'chat_cancelled':
      // A disconnected one-shot chat is not persisted by the service. Keep
      // whatever partial text reached the browser, but do not mark its user
      // turn as durable or leave the response looking live forever.
      return updateStreamingAssistant(state, item => ({ ...item, streaming: false }));

    case 'chat_error': {
      const cleared = updateStreamingAssistant(state, item => ({ ...item, streaming: false }));
      return append(cleared, { kind: 'notice', tone: 'error', text: action.message });
    }

    case 'run_created': {
      if (findRunItem(state, action.run.id)) { return state; }
      return insertRunCard(state, { kind: 'run', run: cardFromRecord(action.run) });
    }

    case 'run_event':
      return applyRunEvent(state, action.runId, action.seq, action.event);

    case 'run_lost': {
      const updated = updateRun(state, action.runId, run =>
        run.status === 'running' ? { ...run, status: 'failed', collapsed: true } : run,
      );
      return append(updated, {
        kind: 'notice',
        tone: 'warn',
        text: 'Lost the live run — showing the durable record instead.',
      });
    }

    case 'approval_submitting':
      return updateRun(state, action.runId, run => ({ ...run, approvalBusy: true }));

    case 'approval_failed': {
      const cleared = updateRun(state, action.runId, run => ({
        ...run,
        approvalBusy: false,
        // gone = the prompt no longer exists server-side (answered elsewhere
        // or timed out); the sheet must come down without a decision event.
        approval: action.gone ? undefined : run.approval,
      }));
      return append(cleared, { kind: 'notice', tone: 'warn', text: action.message });
    }

    case 'user_input_submitting':
      return updateRun(state, action.runId, run => ({ ...run, userInputBusy: true }));

    case 'user_input_failed': {
      const cleared = updateRun(state, action.runId, run => ({
        ...run,
        userInputBusy: false,
        userInput: action.gone ? undefined : run.userInput,
      }));
      return append(cleared, { kind: 'notice', tone: 'warn', text: action.message });
    }

    case 'toggle_run_details':
      return updateRun(state, action.runId, run => ({ ...run, collapsed: !run.collapsed }));

    case 'catch_up': {
      let next = state;
      const bannerRuns: RunRecord[] = [];
      for (const run of action.runs) {
        if (findRunItem(next, run.id)
          || next.discardedRunIds.includes(run.id)
          || next.catchUp.some(existing => existing.id === run.id)) { continue; }
        const durableResponseIndex = matchingDurableResponseIndex(next, run);
        if (durableResponseIndex !== -1) {
          // The persisted assistant turn is the timeline authority after a
          // reload. A retained run record is only needed to restore transient
          // metadata such as generated-file downloads.
          if ((run.artifacts?.length ?? 0) > 0) {
            next = { ...next, items: next.items.map((item, index) => index === durableResponseIndex && item.kind === 'assistant' ? { ...item, runId: run.id, runPhase: 'final' as const } : item) };
            next = insert(next, durableResponseIndex, { kind: 'run', run: cardFromRecord(run) });
          }
          continue;
        }
        if ((run.artifacts?.length ?? 0) > 0) {
          // Deliverables are user-facing session results, not optional run
          // diagnostics. Restore their compact card immediately so a page
          // reload never hides downloads behind the catch-up banner.
          next = insertRunCard(next, { kind: 'run', run: cardFromRecord(run) });
        } else {
          bannerRuns.push(run);
        }
      }
      return bannerRuns.length > 0
        ? { ...next, catchUp: [...next.catchUp, ...bannerRuns] }
        : next;
    }

    case 'dismiss_catch_up':
      return {
        ...state,
        catchUp: action.runId
          ? state.catchUp.filter(run => run.id !== action.runId)
          : [],
      };

    case 'discard_from': {
      const index = state.items.findIndex(item => item.id === action.itemId);
      if (index === -1) { return state; }
      const discardedRunIds = state.items
        .slice(index)
        .flatMap(item => item.kind === 'run' ? [item.run.runId] : []);
      return {
        ...state,
        items: state.items.slice(0, index),
        discardedRunIds: [...new Set([...state.discardedRunIds, ...discardedRunIds])],
      };
    }

    case 'notice':
      return append(state, { kind: 'notice', tone: action.tone, text: action.text });

    default:
      return state;
  }
}

// ── run-event folding ────────────────────────────────────────────────────────

function updateChatReasoning(state: ThreadState, text: string): ThreadState {
  const answerIndex = state.items.findLastIndex(
    item => item.kind === 'assistant' && item.streaming && item.runId === undefined,
  );
  if (answerIndex === -1) { return state; }
  const reasoningIndex = answerIndex - 1;
  const previous = state.items[reasoningIndex];
  if (previous?.kind === 'assistant' && previous.runPhase === 'reasoning') {
    const items = [...state.items];
    items[reasoningIndex] = { ...previous, markdown: previous.markdown + text };
    return { ...state, items };
  }
  const seq = state.seq + 1;
  const reasoning: ThreadItem = {
    id: `item_${seq}`,
    kind: 'assistant',
    markdown: `Reasoning: ${text}`,
    runPhase: 'reasoning',
  };
  return {
    ...state,
    seq,
    items: [...state.items.slice(0, answerIndex), reasoning, ...state.items.slice(answerIndex)],
  };
}

function markLatestPendingUserPersisted(state: ThreadState): ThreadState {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item.kind === 'user' && (item.replacing || item.sessionUserTurnIndex === undefined)) {
      return markUserPersisted(state, item.id);
    }
  }
  return state;
}

const RUN_RESPONSE_MATCH_TOLERANCE_MS = 1_000;

/** Match a transient run registry record to the durable assistant exchange it
 * produced. Registry timestamps bracket the same execution recorded in
 * response metrics, with only a few milliseconds of persistence overhead. */
function matchingDurableResponseIndex(state: ThreadState, run: RunRecord): number {
  const runStartedAt = Date.parse(run.createdAt);
  const runFinishedAt = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
  if (!Number.isFinite(runStartedAt)) { return -1; }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    if (item.kind !== 'assistant' || !item.responseMeta || item.responseMeta.mode === 'chat') { continue; }
    const responseStartedAt = Date.parse(item.responseMeta.startedAt);
    if (!Number.isFinite(responseStartedAt)) { continue; }
    const startDistance = Math.abs(responseStartedAt - runStartedAt);
    if (startDistance > RUN_RESPONSE_MATCH_TOLERANCE_MS) { continue; }

    let finishDistance = 0;
    if (runFinishedAt !== undefined && Number.isFinite(runFinishedAt)) {
      if (!item.responseMeta.finishedAt) { continue; }
      const responseFinishedAt = Date.parse(item.responseMeta.finishedAt);
      if (!Number.isFinite(responseFinishedAt)) { continue; }
      finishDistance = Math.abs(responseFinishedAt - runFinishedAt);
      if (finishDistance > RUN_RESPONSE_MATCH_TOLERANCE_MS) { continue; }
    }

    const distance = startDistance + finishDistance;
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function cardFromRecord(record: RunRecord): RunCardState {
  return {
    ...emptyCard(record.id),
    status: record.status,
    taskId: record.taskId,
    startedAt: record.createdAt,
    finishedAt: record.finishedAt,
    summary: record.summary,
    usage: record.usage,
    artifacts: [...(record.artifacts ?? [])],
    userInput: record.pendingUserInputs[0],
    collapsed: record.status !== 'running',
  };
}

function updateStreamingAssistant(
  state: ThreadState,
  update: (item: Extract<ThreadItem, { kind: 'assistant' }>) => ThreadItem,
): ThreadState {
  const target = state.items.findLast(
    (item): item is Extract<ThreadItem, { kind: 'assistant' }> =>
      item.kind === 'assistant' && item.streaming === true && item.runId === undefined,
  );
  if (!target) { return state; }
  return { ...state, items: state.items.map(item => (item === target ? update(target) : item)) };
}
