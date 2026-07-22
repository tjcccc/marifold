import { JSONValue } from '@priest-ai/core';
import { TaskPlanItem, TaskStatus, TaskStepStatus } from '../tasks/TaskStore';
import { ApprovalRequest, ToolKind } from './ApprovalPolicy';

/** Token usage accumulated over an agent run's model calls (plan, loop turns,
 * verification), as reported by the provider. Fields are undefined when the
 * provider does not report usage (e.g. some local models). */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Portion of inputTokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
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
  /** User guidance queued mid-run (`/btw` or a service steer call), emitted
   * when the runner drains it — so every attached client sees it in context. */
  | { type: 'steering'; taskId: string; text: string }
  | {
      type: 'tool_request';
      call: {
        id: string;
        tool: string;
        kind: ToolKind;
        input: Record<string, JSONValue>;
        summary: string;
      };
    }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_decision'; requestId: string; approved: boolean; source: 'policy' | 'user'; reason?: string }
  | { type: 'tool_result'; callId: string; tool: string; summary: string; isError: boolean }
  | { type: 'verification'; passed: boolean; notes: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; taskId: string; status: TaskStatus; summary?: string; usage?: AgentUsage };
