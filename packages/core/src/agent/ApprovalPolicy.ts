import { JSONValue } from '@priest-ai/core';

export type ToolKind = 'read' | 'write' | 'shell' | 'network' | 'delegate';
export type ApprovalMode = 'allow' | 'ask' | 'deny';

export interface AgentApprovalConfig {
  read: ApprovalMode;
  write: ApprovalMode;
  shell: ApprovalMode;
  network: ApprovalMode;
  delegate: ApprovalMode;
}

export interface MarifoldAgentConfig {
  approval: AgentApprovalConfig;
  /** Approval overrides for unattended runs (scheduled tasks). Merged over
   * approval; 'ask' still degrades to deny when no handler is present, so
   * only explicit 'allow' entries widen unattended capability. */
  unattended?: Partial<AgentApprovalConfig>;
  maxIterations: number;
  toolOutputLimit: number;
  toolMode: AgentToolMode;
}

/**
 * How the model requests tool calls. 'native' uses provider tool calling,
 * 'control-block' uses prompt-embedded <tool_call> blocks for models without
 * native support, and 'auto' tries native first and falls back when the
 * provider rejects tools.
 */
export type AgentToolMode = 'auto' | 'native' | 'control-block';

export const DEFAULT_AGENT_CONFIG: MarifoldAgentConfig = {
  approval: {
    read: 'allow',
    write: 'ask',
    shell: 'ask',
    network: 'ask',
    delegate: 'allow',
  },
  maxIterations: 20,
  toolOutputLimit: 100000,
  toolMode: 'auto',
};

export interface PartialAgentConfig {
  approval?: Partial<AgentApprovalConfig>;
  unattended?: Partial<AgentApprovalConfig>;
  maxIterations?: number;
  toolOutputLimit?: number;
  toolMode?: AgentToolMode;
}

/** Effective agent config: user overrides merged over defaults. */
export function resolveAgentConfig(partial?: PartialAgentConfig): MarifoldAgentConfig {
  return {
    approval: { ...DEFAULT_AGENT_CONFIG.approval, ...(partial?.approval ?? {}) },
    ...(partial?.unattended && Object.keys(partial.unattended).length > 0 ? { unattended: { ...partial.unattended } } : {}),
    maxIterations: partial?.maxIterations ?? DEFAULT_AGENT_CONFIG.maxIterations,
    toolOutputLimit: partial?.toolOutputLimit ?? DEFAULT_AGENT_CONFIG.toolOutputLimit,
    toolMode: partial?.toolMode ?? DEFAULT_AGENT_CONFIG.toolMode,
  };
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  /** Human-readable one-liner, e.g. "write 2.1KB to ./notes.md". */
  summary: string;
  input: Record<string, JSONValue>;
  /** True when the tool flagged this call as riskier than its kind suggests
   * (e.g. a write outside the workspace). Escalated calls always ask. */
  escalated: boolean;
  /** Tool-provided reason for the escalation. */
  escalationReason?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

/**
 * Resolves 'ask'-mode approval requests. The CLI implements this with a
 * readline prompt; future clients bring their own UI. When no handler is
 * provided (unattended runs), 'ask' degrades to deny.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
