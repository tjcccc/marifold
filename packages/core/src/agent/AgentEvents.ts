import { JSONValue } from '@priest-ai/core';
import { TaskPlanItem, TaskStatus, TaskStepStatus } from '../tasks/TaskStore';
import { ApprovalRequest } from './ApprovalPolicy';
import type { AgentToolKind } from './ToolRegistry';
import type { UserInputRequest, UserInputResponse } from './UserInput';

/** Token usage accumulated over an agent run's model calls (plan, loop turns,
 * verification), as reported by the provider. Fields are undefined when the
 * provider does not report usage (e.g. some local models). */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Portion of inputTokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  /** Portion of outputTokens used for provider reasoning, when reported. */
  reasoningTokens?: number;
  estimatedCostUSD?: number;
}

/**
 * Renderer-agnostic agent run events. This union is the contract every
 * Marifold client (CLI today; TUI, Web UI, and Apple clients later) renders,
 * so keep payloads self-describing and free of terminal formatting.
 */
export type AgentEvent =
  | { type: 'status'; taskId: string; status: TaskStatus }
  | { type: 'plan'; taskId: string; plan: TaskPlanItem[] }
  | { type: 'step'; taskId: string; stepId: string; text: string; status: TaskStepStatus }
  | {
      type: 'text';
      text: string;
      /** `progress` is model commentary before a tool call; `final` is the
       * completed answer. Omitted events from older clients are final. */
      phase?: 'progress' | 'final';
    }
  /** Provider-supplied safe reasoning summary. Opaque/private reasoning state
   * never crosses the renderer contract. */
  | { type: 'reasoning'; summary: string }
  /** User guidance queued mid-run (`/btw` or a service steer call), emitted
   * when the runner drains it — so every attached client sees it in context. */
  | { type: 'steering'; taskId: string; text: string }
  | {
      type: 'tool_request';
      call: {
        id: string;
        tool: string;
        kind: AgentToolKind;
        input: Record<string, JSONValue>;
        summary: string;
      };
    }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_decision'; requestId: string; approved: boolean; source: 'policy' | 'user'; reason?: string }
  | { type: 'user_input_request'; request: UserInputRequest }
  | { type: 'user_input_response'; response: UserInputResponse }
  | { type: 'tool_result'; callId: string; tool: string; summary: string; isError: boolean }
  | { type: 'verification'; passed: boolean; notes: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; taskId: string; status: TaskStatus; summary?: string; usage?: AgentUsage };
