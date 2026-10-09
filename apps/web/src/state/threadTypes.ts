import type { AgentToolKind, AgentUsage, ApprovalRequest, RunRecord, RunArtifact, TaskStatus, TaskStepStatus, UserInputRequest, UserInputResponse } from '../api/types';

// Thread state shapes: transcript items, run cards, tool rows, and attachments.

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

/** Omit distributed over the union (plain Omit collapses union members). */
export type NewThreadItem = { [K in ThreadItem['kind']]: Omit<Extract<ThreadItem, { kind: K }>, 'id'> }[ThreadItem['kind']];
