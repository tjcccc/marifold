import type {
  AgentEvent,
  AgentUsage,
  ApprovalRequest,
  RunRecord,
  TaskStatus,
  TaskStepStatus,
  ToolKind,
} from '../api/types';

/**
 * The conversation model: one thread per session, composed from replayed
 * session turns, live chat streams, and live agent runs (grouped into cards).
 * Pure reducer — no React, no fetch — so every transition is unit-testable.
 */

export interface ToolRowState {
  callId: string;
  tool: string;
  kind?: ToolKind;
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
  steering: string[];
  denials: string[];
  errors: Array<{ code: string; message: string }>;
  summary?: string;
  usage?: AgentUsage;
  /** Finished cards fold to the footer; toggled by "Show". */
  collapsed: boolean;
}

/** What the user bubble shows for an attachment; the payload itself goes to
 * the service (images) or is inlined into the prompt (text files). */
export interface UserAttachment {
  kind: 'image' | 'text';
  name: string;
  /** data: URL thumbnail for images. */
  previewUrl?: string;
}

export type ThreadItem =
  | { id: string; kind: 'user'; text: string; attachments?: UserAttachment[] }
  | { id: string; kind: 'assistant'; markdown: string; streaming?: boolean; runId?: string }
  | { id: string; kind: 'run'; run: RunCardState }
  | { id: string; kind: 'notice'; tone: 'info' | 'warn' | 'error'; text: string };

export interface ThreadState {
  sessionId?: string;
  items: ThreadItem[];
  /** Finished-while-away runs surfaced by the catch-up banner. */
  catchUp: RunRecord[];
  seq: number;
}

export type ThreadAction =
  | { type: 'reset'; sessionId?: string }
  | { type: 'session_loaded'; turns: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'user_message'; text: string; attachments?: UserAttachment[] }
  | { type: 'chat_started' }
  | { type: 'chat_chunk'; text: string }
  | { type: 'chat_done' }
  | { type: 'chat_error'; message: string }
  | { type: 'run_created'; run: RunRecord }
  | { type: 'run_event'; runId: string; seq: number; event: AgentEvent }
  | { type: 'run_lost'; runId: string }
  | { type: 'approval_submitting'; runId: string }
  | { type: 'approval_failed'; runId: string; message: string; gone?: boolean }
  | { type: 'toggle_run_details'; runId: string }
  | { type: 'catch_up'; runs: RunRecord[] }
  | { type: 'dismiss_catch_up' }
  | { type: 'notice'; tone: 'info' | 'warn' | 'error'; text: string };

export function createThreadState(sessionId?: string): ThreadState {
  return { sessionId, items: [], catchUp: [], seq: 0 };
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
    run.approval !== undefined
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
      for (const turn of action.turns) {
        next = append(
          next,
          turn.role === 'user'
            ? { kind: 'user', text: turn.content }
            : { kind: 'assistant', markdown: turn.content },
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

    case 'chat_started':
      return append(state, { kind: 'assistant', markdown: '', streaming: true });

    case 'chat_chunk':
      return updateStreamingAssistant(state, item => ({ ...item, markdown: item.markdown + action.text }));

    case 'chat_done':
      return updateStreamingAssistant(state, item => ({ ...item, streaming: false }));

    case 'chat_error': {
      const cleared = updateStreamingAssistant(state, item => ({ ...item, streaming: false }));
      return append(cleared, { kind: 'notice', tone: 'error', text: action.message });
    }

    case 'run_created': {
      if (findRunItem(state, action.run.id)) return state;
      return append(state, { kind: 'run', run: cardFromRecord(action.run) });
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

    case 'toggle_run_details':
      return updateRun(state, action.runId, run => ({ ...run, collapsed: !run.collapsed }));

    case 'catch_up': {
      const unseen = action.runs.filter(
        run => !findRunItem(state, run.id) && !state.catchUp.some(existing => existing.id === run.id),
      );
      if (unseen.length === 0) return state;
      return { ...state, catchUp: [...state.catchUp, ...unseen] };
    }

    case 'dismiss_catch_up':
      return { ...state, catchUp: [] };

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
    : append(state, { kind: 'run', run: emptyCard(runId) });

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
      if (event.text.trim().length > 0) next = appendRunText(next, runId, event.text);
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

    case 'error':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        errors: [...run.errors, { code: event.code, message: event.message }],
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
        finishedAt: new Date().toISOString(),
        collapsed: true,
      }));
      next = updateStreamingRunText(next, runId);
      break;

    default:
      // Unknown event types are no-ops by contract (the union may grow).
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      break;
  }
  return next;
}

/** The run's prose lands as a normal assistant message after its card. */
function appendRunText(state: ThreadState, runId: string, text: string): ThreadState {
  const existing = state.items.findLast(
    (item): item is Extract<ThreadItem, { kind: 'assistant' }> =>
      item.kind === 'assistant' && item.runId === runId,
  );
  if (existing) {
    return {
      ...state,
      items: state.items.map(item =>
        item === existing ? { ...existing, markdown: `${existing.markdown}\n\n${text}` } : item,
      ),
    };
  }
  return append(state, { kind: 'assistant', markdown: text, streaming: true, runId });
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
