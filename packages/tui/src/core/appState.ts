import type { AgentEvent, AgentToolKind, ApprovalRequest, UserInputRequest } from '@marifold/core';
import { agentEventToItems } from './eventView.js';

export type Mode = 'agent' | 'chat';

export type NoticeTone = 'info' | 'warn' | 'error';

/** A renderable transcript entry without its assigned id. */
export type TranscriptItemData =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; muted?: boolean }
  | { kind: 'notice'; tone: NoticeTone; text: string }
  | { kind: 'plan'; steps: Array<{ id: string; text: string; status: string }> }
  | { kind: 'tool'; tool: string; toolKind?: AgentToolKind; summary: string; phase: 'request' | 'result'; isError?: boolean; callId?: string }
  | { kind: 'verification'; passed: boolean; notes: string }
  | { kind: 'info'; title: string; lines: string[] };

export type TranscriptItem = TranscriptItemData & { id: string };

export interface AppState {
  profile: string;
  provider: string;
  model: string;
  mode: Mode;
  cwd: string;
  /** This build's version, shown in the header banner. */
  version: string;
  /** A known newer version; drives the header's update notice when set. */
  latestVersion?: string;
  sessionId?: string;
  /** Conversation-context budget in tokens for the active profile (undefined = compaction off). */
  maxContextTokens?: number;
  /** Input tokens the last turn sent — drives the context gauge. */
  contextTokens?: number;
  transcript: TranscriptItem[];
  running: boolean;
  /** Pending approval request; non-undefined drives the approval modal. */
  approval?: ApprovalRequest;
  /** Pending clarification questions; non-undefined drives QuestionModal. */
  userInput?: UserInputRequest;
  /** Short status-line activity label, e.g. "thinking" or "shell". */
  activity?: string;
  /** True while an assistant item is open and accepting streamed deltas. */
  streamingAssistant: boolean;
  exiting: boolean;
  seq: number;
}

export interface InitialAppState {
  profile: string;
  provider: string;
  model: string;
  cwd: string;
  version: string;
  latestVersion?: string;
  mode?: Mode;
  sessionId?: string;
  /** Conversation-context budget in tokens for the launch profile (undefined = off). */
  maxContextTokens?: number;
  /** Pre-existing transcript to seed (e.g. a resumed session's turns). */
  transcript?: TranscriptItemData[];
}

export function createInitialState(init: InitialAppState): AppState {
  // Seed any provided history with the same `item_${seq}` id scheme the reducer
  // uses, and start `seq` past it so later items continue the sequence.
  const seeded = (init.transcript ?? []).map((item, index) => ({ ...item, id: `item_${index + 1}` }));
  return {
    profile: init.profile,
    provider: init.provider,
    model: init.model,
    mode: init.mode ?? 'agent',
    cwd: init.cwd,
    version: init.version,
    ...(init.latestVersion ? { latestVersion: init.latestVersion } : {}),
    ...(init.sessionId ? { sessionId: init.sessionId } : {}),
    ...(init.maxContextTokens != null ? { maxContextTokens: init.maxContextTokens } : {}),
    transcript: seeded,
    running: false,
    streamingAssistant: false,
    exiting: false,
    seq: seeded.length,
  };
}

export type AppAction =
  | { type: 'set_mode'; mode: Mode }
  | { type: 'set_model'; provider: string; model: string }
  | { type: 'set_profile'; profile: string; provider: string; model: string; maxContextTokens?: number }
  | { type: 'add_user'; text: string }
  | { type: 'add_item'; item: TranscriptItemData }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'end_assistant' }
  | { type: 'set_running'; running: boolean }
  | { type: 'set_activity'; activity?: string }
  | { type: 'set_approval'; request?: ApprovalRequest }
  | { type: 'set_user_input'; request?: UserInputRequest }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'notice'; tone?: NoticeTone; text: string }
  | { type: 'clear' }
  | { type: 'new_session'; sessionId?: string }
  | { type: 'set_session'; sessionId?: string }
  | { type: 'set_context_usage'; tokens?: number }
  | { type: 'set_context_budget'; maxContextTokens?: number }
  | { type: 'exit' };

function withItem(state: AppState, item: TranscriptItemData): AppState {
  const seq = state.seq + 1;
  return { ...state, seq, transcript: [...state.transcript, { ...item, id: `item_${seq}` }] };
}

function withItems(state: AppState, items: TranscriptItemData[]): AppState {
  return items.reduce(withItem, state);
}

/**
 * Pure reducer over the whole TUI state. All transcript mutation, streaming,
 * approval, and run lifecycle flows through here so behavior is unit-testable
 * without rendering Ink. Components only dispatch and read.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'set_mode':
      return { ...state, mode: action.mode };
    case 'set_model':
      return { ...state, provider: action.provider, model: action.model };
    case 'set_profile':
      return {
        ...state,
        profile: action.profile,
        provider: action.provider,
        model: action.model,
        maxContextTokens: action.maxContextTokens,
        contextTokens: undefined,
      };
    case 'add_user':
      return withItem(state, { kind: 'user', text: action.text });
    case 'add_item':
      return withItem(state, action.item);
    case 'reasoning_delta': {
      const transcript = [...state.transcript];
      const last = transcript[transcript.length - 1];
      if (!state.streamingAssistant && last?.kind === 'assistant' && last.muted) {
        transcript[transcript.length - 1] = { ...last, text: last.text + action.text };
        return { ...state, transcript };
      }
      return withItem(state, { kind: 'assistant', text: `Reasoning: ${action.text}`, muted: true });
    }
    case 'assistant_delta': {
      // Append to the open assistant item, or open a new one.
      if (state.streamingAssistant) {
        const transcript = [...state.transcript];
        const last = transcript[transcript.length - 1];
        if (last && last.kind === 'assistant') {
          transcript[transcript.length - 1] = { ...last, text: last.text + action.text };
          return { ...state, transcript };
        }
      }
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        streamingAssistant: true,
        transcript: [...state.transcript, { id: `item_${seq}`, kind: 'assistant', text: action.text }],
      };
    }
    case 'end_assistant':
      return { ...state, streamingAssistant: false };
    case 'set_running':
      return { ...state, running: action.running, ...(action.running ? {} : { activity: undefined }) };
    case 'set_activity':
      return { ...state, activity: action.activity };
    case 'set_approval':
      return { ...state, approval: action.request };
    case 'set_user_input':
      return { ...state, userInput: action.request };
    case 'agent_event':
      return applyAgentEvent(state, action.event);
    case 'notice':
      return withItem(state, { kind: 'notice', tone: action.tone ?? 'info', text: action.text });
    case 'clear':
      return { ...state, transcript: [], streamingAssistant: false };
    case 'new_session':
      return { ...state, transcript: [], streamingAssistant: false, sessionId: action.sessionId, contextTokens: undefined };
    case 'set_session':
      return { ...state, sessionId: action.sessionId };
    case 'set_context_usage':
      return { ...state, contextTokens: action.tokens };
    case 'set_context_budget':
      return { ...state, maxContextTokens: action.maxContextTokens };
    case 'exit':
      return { ...state, exiting: true };
    default:
      return state;
  }
}

/** Fold a single AgentEvent into state: transcript items via eventView, plus
 * the status-line / modal transitions the transcript itself doesn't show. */
function applyAgentEvent(state: AppState, event: AgentEvent): AppState {
  // A tool result folds onto its own request row (matched by callId) so each
  // tool call is one self-updating line — `→ read_file …` becomes `← read_file …`
  // in place — instead of two rows with the path repeated.
  if (event.type === 'tool_result') {
    const transcript = [...state.transcript];
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const item = transcript[i];
      if (item.kind === 'tool' && item.callId === event.callId && item.phase === 'request') {
        // New id so the App's append-only <Static> repaints this row in place
        // (it only redraws on id changes), turning `→ …` into `← …` on one line.
        transcript[i] = { ...item, id: `${item.id}~done`, phase: 'result', summary: event.summary, isError: event.isError };
        return { ...state, streamingAssistant: false, transcript };
      }
    }
    // No matching request found — fall back to appending a standalone result.
    return withItems({ ...state, streamingAssistant: false }, agentEventToItems(event));
  }
  let next = withItems({ ...state, streamingAssistant: false }, agentEventToItems(event));
  switch (event.type) {
    case 'status':
      next = { ...next, activity: event.status === 'running' ? 'thinking' : undefined };
      break;
    case 'tool_request':
      next = { ...next, activity: event.call.tool };
      break;
    case 'text':
      next = { ...next, activity: 'thinking' };
      break;
    case 'reasoning':
      next = { ...next, activity: 'reasoning' };
      break;
    case 'approval_request':
      next = { ...next, approval: event.request };
      break;
    case 'approval_decision':
      next = { ...next, approval: undefined };
      break;
    case 'user_input_request':
      next = { ...next, userInput: event.request, activity: 'waiting for your answers' };
      break;
    case 'user_input_response':
      next = { ...next, userInput: undefined, activity: 'thinking' };
      break;
    case 'done':
      next = { ...next, running: false, activity: undefined, approval: undefined, userInput: undefined };
      break;
    default:
      break;
  }
  return next;
}
