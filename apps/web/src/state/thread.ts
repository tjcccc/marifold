import type {
  AgentEvent,
  AgentToolKind,
  AgentUsage,
  ApprovalRequest,
  RunRecord,
  RunArtifact,
  TaskStatus,
  TaskStepStatus,
  UserInputRequest,
  UserInputResponse,
} from '../api/types';

/**
 * The conversation model: one thread per session, composed from replayed
 * session turns, live chat streams, and live agent runs (grouped into cards).
 * Pure reducer — no React, no fetch — so every transition is unit-testable.
 */

export interface ToolRowState {
  callId: string;
  tool: string;
  kind?: AgentToolKind;
  summary: string;
  phase: 'running' | 'done';
  isError?: boolean;
}

export interface RunCardState {
  runId: string;
  status: TaskStatus;
  taskId?: string;
  lastSeq: number;
  startedAt: string;
  finishedAt?: string;
  plan?: Array<{ id: string; text: string; status: TaskStepStatus }>;
  rows: ToolRowState[];
  /** Non-undefined → the approval sheet is up and the run is blocked. */
  approval?: ApprovalRequest;
  /** True while the answer POST is in flight (disables the sheet buttons). */
  approvalBusy?: boolean;
  /** Non-undefined → the agent is waiting for all clarification answers. */
  userInput?: UserInputRequest;
  /** True while the complete answer set is being submitted. */
  userInputBusy?: boolean;
  /** Resolved questions stay visible in the run history. */
  inputResponses: Array<{ request: UserInputRequest; response: UserInputResponse }>;
  steering: string[];
  denials: string[];
  errors: Array<{ code: string; message: string }>;
  summary?: string;
  usage?: AgentUsage;
  artifacts: RunArtifact[];
  /** Finished cards fold to the footer; toggled by "Show". */
  collapsed: boolean;
}

export interface ResponseMetaState {
  mode?: 'agent' | 'chat';
  startedAt: string;
  finishedAt?: string;
  /** End-to-end service latency for this chat request. */
  latencyMs?: number;
  usage?: AgentUsage;
}

/** What the user bubble shows for an attachment; generic binary payloads are
 * deliberately turn-local and are staged only for the active agent run. */
export interface UserAttachment {
  kind: 'image' | 'text' | 'file';
  name: string;
  officeKind?: 'word' | 'spreadsheet' | 'presentation';
  /** Retained locally/recovered from the durable inlined prompt so text and
   * Office attachments survive historical edit/resend. Never rendered raw. */
  content?: string;
  truncated?: boolean;
  /** data: URL thumbnail for images. */
  previewUrl?: string;
  /** Authenticated service path for a lazily loaded persisted image. */
  sourcePath?: string;
}

export type ThreadItem =
  | {
      id: string;
      kind: 'user';
      text: string;
      attachments?: UserAttachment[];
      /** Zero-based ordinal among durable session user turns. Live attempts
       * receive it only after their response is successfully persisted. */
      sessionUserTurnIndex?: number;
      /** An earlier persisted exchange is being regenerated in place. */
      replacing?: boolean;
    }
  | {
      id: string;
      kind: 'assistant';
      markdown: string;
      streaming?: boolean;
      runId?: string;
      /** Safe reasoning summary, model commentary, or the completed answer. */
      runPhase?: 'reasoning' | 'progress' | 'final';
      /** Completion metadata for a plain chat turn. Agent turns resolve the
       * equivalent data through their runId. */
      responseMeta?: ResponseMetaState;
    }
  | { id: string; kind: 'run'; run: RunCardState }
  | { id: string; kind: 'notice'; tone: 'info' | 'warn' | 'error'; text: string };

export interface ThreadState {
  sessionId?: string;
  items: ThreadItem[];
  /** Finished-while-away runs surfaced by the catch-up banner. */
  catchUp: RunRecord[];
  /** Finished run records removed by a retry/edit must not reappear in the
   * catch-up banner while the service still retains them. */
  discardedRunIds: string[];
  seq: number;
}

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
    if (item.kind === 'run' && item.run.status === 'running') return item.run;
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
      if (index === -1) return state;
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
      if (findRunItem(state, action.run.id)) return state;
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
          || next.catchUp.some(existing => existing.id === run.id)) continue;
        const durableResponseIndex = matchingDurableResponseIndex(next, run);
        if (durableResponseIndex !== -1) {
          // The persisted assistant turn is the timeline authority after a
          // reload. A retained run record is only needed to restore transient
          // metadata such as generated-file downloads.
          if ((run.artifacts?.length ?? 0) > 0) {
            next = insert(next, durableResponseIndex + 1, { kind: 'run', run: cardFromRecord(run) });
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
      if (index === -1) return state;
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

function applyRunEvent(state: ThreadState, runId: string, seq: number, event: AgentEvent): ThreadState {
  // Auto-create the card for runs discovered mid-stream (catch-up "Show",
  // runs started from another client).
  let next = findRunItem(state, runId)
    ? state
    : insertRunCard(state, { kind: 'run', run: emptyCard(runId) });

  const card = findRunItem(next, runId)!.run;
  if (seq <= card.lastSeq) return state; // replay overlap — drop

  switch (event.type) {
    case 'status':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        status: event.status,
        taskId: run.taskId ?? event.taskId,
      }));
      break;

    case 'plan':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        plan: event.plan.map(step => ({ id: step.id, text: step.text, status: step.status })),
      }));
      break;

    case 'step':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        plan: run.plan?.map(step => (step.id === event.stepId ? { ...step, status: event.status } : step)),
      }));
      break;

    case 'text': {
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      if (event.text.trim().length > 0) {
        next = appendRunText(next, runId, event.text, event.phase ?? 'final');
      }
      break;
    }

    case 'reasoning': {
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      if (event.summary.trim().length > 0) {
        next = appendRunText(next, runId, `Reasoning: ${event.summary}`, 'reasoning');
      }
      break;
    }

    case 'steering':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        steering: [...run.steering, event.text],
      }));
      break;

    case 'tool_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        rows: [
          ...run.rows,
          {
            callId: event.call.id,
            tool: event.call.tool,
            kind: event.call.kind,
            summary: event.call.summary,
            phase: 'running',
          },
        ],
      }));
      break;

    case 'tool_result':
      next = updateRun(next, runId, run => {
        const matched = run.rows.some(row => row.callId === event.callId);
        const rows: ToolRowState[] = matched
          ? run.rows.map(row =>
              row.callId === event.callId
                ? { ...row, summary: event.summary, phase: 'done' as const, isError: event.isError }
                : row,
            )
          : [
              ...run.rows,
              { callId: event.callId, tool: event.tool, summary: event.summary, phase: 'done' as const, isError: event.isError },
            ];
        return { ...run, lastSeq: seq, rows };
      });
      break;

    case 'approval_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        approval: event.request,
        approvalBusy: false,
      }));
      break;

    case 'approval_decision':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        approval: undefined,
        approvalBusy: false,
        denials:
          !event.approved && event.source === 'user' && event.reason
            ? [...run.denials, event.reason]
            : run.denials,
      }));
      break;

    case 'user_input_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        userInput: event.request,
        userInputBusy: false,
      }));
      break;

    case 'user_input_response':
      next = updateRun(next, runId, run => {
        const request = run.userInput;
        return {
          ...run,
          lastSeq: seq,
          userInput: undefined,
          userInputBusy: false,
          inputResponses: request && request.id === event.response.requestId
            ? [...run.inputResponses, { request, response: event.response }]
            : run.inputResponses,
        };
      });
      break;

    case 'error':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        errors: [...run.errors, { code: event.code, message: event.message }],
      }));
      break;

    case 'artifact':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        artifacts: run.artifacts.some(artifact => artifact.id === event.artifact.id)
          ? run.artifacts
          : [...run.artifacts, event.artifact],
      }));
      break;

    case 'done':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        status: event.status,
        taskId: run.taskId ?? event.taskId,
        summary: event.summary,
        usage: event.usage,
        approval: undefined,
        approvalBusy: false,
        userInput: undefined,
        userInputBusy: false,
        finishedAt: new Date().toISOString(),
        collapsed: true,
      }));
      next = updateStreamingRunText(next, runId);
      if (event.status === 'completed') next = markRunUserPersisted(next, runId);
      break;

    default:
      // Unknown event types are no-ops by contract (the union may grow).
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      break;
  }
  return next;
}

/** Each model turn lands after the run card as its own assistant item so
 * progress commentary can be muted without muting the final answer. */
function appendRunText(
  state: ThreadState,
  runId: string,
  text: string,
  runPhase: 'reasoning' | 'progress' | 'final',
): ThreadState {
  const closed = updateStreamingRunText(state, runId);
  const lastRunItem = closed.items.findLastIndex(
    item => (item.kind === 'run' && item.run.runId === runId)
      || (item.kind === 'assistant' && item.runId === runId),
  );
  const assistant = { kind: 'assistant' as const, markdown: text, streaming: true, runId, runPhase };
  return lastRunItem === -1 ? append(closed, assistant) : insert(closed, lastRunItem + 1, assistant);
}

function updateChatReasoning(state: ThreadState, text: string): ThreadState {
  const answerIndex = state.items.findLastIndex(
    item => item.kind === 'assistant' && item.streaming && item.runId === undefined,
  );
  if (answerIndex === -1) return state;
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

function updateStreamingRunText(state: ThreadState, runId: string): ThreadState {
  return {
    ...state,
    items: state.items.map(item =>
      item.kind === 'assistant' && item.runId === runId && item.streaming
        ? { ...item, streaming: false }
        : item,
    ),
  };
}

function markRunUserPersisted(state: ThreadState, runId: string): ThreadState {
  const runIndex = state.items.findIndex(item => item.kind === 'run' && item.run.runId === runId);
  if (runIndex === -1) return state;
  for (let index = runIndex - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item.kind === 'user') return markUserPersisted(state, item.id);
  }
  return state;
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

function markUserPersisted(state: ThreadState, itemId: string): ThreadState {
  const item = state.items.find(candidate => candidate.id === itemId);
  if (!item || item.kind !== 'user') return state;
  if (item.sessionUserTurnIndex !== undefined) {
    if (!item.replacing) return state;
    return {
      ...state,
      items: state.items.map(candidate => candidate.id === itemId
        ? { ...item, replacing: undefined }
        : candidate),
    };
  }
  const nextIndex = state.items.reduce(
    (highest, candidate) => candidate.kind === 'user' && candidate.sessionUserTurnIndex !== undefined
      ? Math.max(highest, candidate.sessionUserTurnIndex)
      : highest,
    -1,
  ) + 1;
  return {
    ...state,
    items: state.items.map(candidate => candidate.id === itemId
      ? { ...item, sessionUserTurnIndex: nextIndex }
      : candidate),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Omit distributed over the union (plain Omit collapses union members). */
type NewThreadItem = { [K in ThreadItem['kind']]: Omit<Extract<ThreadItem, { kind: K }>, 'id'> }[ThreadItem['kind']];

function append(state: ThreadState, item: NewThreadItem): ThreadState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [...state.items, { ...item, id: `item_${seq}` } as ThreadItem],
  };
}

function insert(state: ThreadState, index: number, item: NewThreadItem): ThreadState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [
      ...state.items.slice(0, index),
      { ...item, id: `item_${seq}` } as ThreadItem,
      ...state.items.slice(index),
    ],
  };
}

function insertRunCard(
  state: ThreadState,
  item: Extract<NewThreadItem, { kind: 'run' }>,
): ThreadState {
  const replacingIndex = state.items.findIndex(candidate => candidate.kind === 'user' && candidate.replacing);
  return replacingIndex === -1 ? append(state, item) : insert(state, replacingIndex + 1, item);
}

const RUN_RESPONSE_MATCH_TOLERANCE_MS = 1_000;

/** Match a transient run registry record to the durable assistant exchange it
 * produced. Registry timestamps bracket the same execution recorded in
 * response metrics, with only a few milliseconds of persistence overhead. */
function matchingDurableResponseIndex(state: ThreadState, run: RunRecord): number {
  const runStartedAt = Date.parse(run.createdAt);
  const runFinishedAt = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
  if (!Number.isFinite(runStartedAt)) return -1;

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    if (item.kind !== 'assistant' || !item.responseMeta || item.responseMeta.mode === 'chat') continue;
    const responseStartedAt = Date.parse(item.responseMeta.startedAt);
    if (!Number.isFinite(responseStartedAt)) continue;
    const startDistance = Math.abs(responseStartedAt - runStartedAt);
    if (startDistance > RUN_RESPONSE_MATCH_TOLERANCE_MS) continue;

    let finishDistance = 0;
    if (runFinishedAt !== undefined && Number.isFinite(runFinishedAt)) {
      if (!item.responseMeta.finishedAt) continue;
      const responseFinishedAt = Date.parse(item.responseMeta.finishedAt);
      if (!Number.isFinite(responseFinishedAt)) continue;
      finishDistance = Math.abs(responseFinishedAt - runFinishedAt);
      if (finishDistance > RUN_RESPONSE_MATCH_TOLERANCE_MS) continue;
    }

    const distance = startDistance + finishDistance;
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function findRunItem(state: ThreadState, runId: string): Extract<ThreadItem, { kind: 'run' }> | undefined {
  return state.items.find(
    (item): item is Extract<ThreadItem, { kind: 'run' }> => item.kind === 'run' && item.run.runId === runId,
  );
}

function updateRun(
  state: ThreadState,
  runId: string,
  update: (run: RunCardState) => RunCardState,
): ThreadState {
  return {
    ...state,
    items: state.items.map(item =>
      item.kind === 'run' && item.run.runId === runId ? { ...item, run: update(item.run) } : item,
    ),
  };
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

function emptyCard(runId: string): RunCardState {
  return {
    runId,
    status: 'running',
    lastSeq: 0,
    startedAt: new Date().toISOString(),
    rows: [],
    artifacts: [],
    inputResponses: [],
    steering: [],
    denials: [],
    errors: [],
    collapsed: false,
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
  if (!target) return state;
  return { ...state, items: state.items.map(item => (item === target ? update(target) : item)) };
}
