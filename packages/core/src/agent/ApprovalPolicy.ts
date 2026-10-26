import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';

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
  /** Extra filesystem capabilities outside the working directory. In-home
   * entries are auto-approved; entries outside $HOME still prompt per action. */
  trustedFolders: string[];
  /** Sensitive read roots the user chose to "Always allow", home-relative
   * (e.g. `~/.ssh`) so one grant applies on every device of the workspace. */
  sensitiveReadGrants: string[];
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
  trustedFolders: [],
  sensitiveReadGrants: [],
  maxIterations: 20,
  toolOutputLimit: 100000,
  toolMode: 'auto',
};

export interface PartialAgentConfig {
  approval?: Partial<AgentApprovalConfig>;
  unattended?: Partial<AgentApprovalConfig>;
  trustedFolders?: string[];
  sensitiveReadGrants?: string[];
  maxIterations?: number;
  toolOutputLimit?: number;
  toolMode?: AgentToolMode;
}

/** Effective agent config: user overrides merged over defaults. */
export function resolveAgentConfig(partial?: PartialAgentConfig): MarifoldAgentConfig {
  return {
    approval: { ...DEFAULT_AGENT_CONFIG.approval, ...(partial?.approval ?? {}) },
    ...(partial?.unattended && Object.keys(partial.unattended).length > 0 ? { unattended: { ...partial.unattended } } : {}),
    trustedFolders: [...(partial?.trustedFolders ?? DEFAULT_AGENT_CONFIG.trustedFolders)],
    sensitiveReadGrants: [...(partial?.sensitiveReadGrants ?? DEFAULT_AGENT_CONFIG.sensitiveReadGrants)],
    maxIterations: partial?.maxIterations ?? DEFAULT_AGENT_CONFIG.maxIterations,
    toolOutputLimit: partial?.toolOutputLimit ?? DEFAULT_AGENT_CONFIG.toolOutputLimit,
    toolMode: partial?.toolMode ?? DEFAULT_AGENT_CONFIG.toolMode,
  };
}

/** A profile's `[agent]` overrides merged over the effective global config.
 * Trusted folders and sensitive read grants are additive. */
export function mergeAgentConfig(global: MarifoldAgentConfig, override: PartialAgentConfig | undefined): MarifoldAgentConfig {
  if (!override) { return global; }
  const unattended = { ...(global.unattended ?? {}), ...(override.unattended ?? {}) };
  return {
    approval: { ...global.approval, ...(override.approval ?? {}) },
    ...(Object.keys(unattended).length > 0 ? { unattended } : {}),
    trustedFolders: [...new Set([...global.trustedFolders, ...(override.trustedFolders ?? [])])],
    sensitiveReadGrants: [...new Set([...global.sensitiveReadGrants, ...(override.sensitiveReadGrants ?? [])])],
    maxIterations: override.maxIterations ?? global.maxIterations,
    toolOutputLimit: override.toolOutputLimit ?? global.toolOutputLimit,
    toolMode: override.toolMode ?? global.toolMode,
  };
}

/** True when policy alone approves a call before any prompt: a tool-trusted
 * capability, routine file work the kind's mode does not deny, or a sensitive
 * read the profile already allows. */
export function preApproved(
  risk: import('./ToolRegistry').ToolRiskAssessment,
  mode: ApprovalMode,
  config: Pick<MarifoldAgentConfig, 'sensitiveReadGrants'>,
): boolean {
  if (risk.trusted) { return true; }
  if (mode === 'deny') { return false; }
  if (risk.routine && !risk.escalate) { return true; }
  return risk.sensitiveGrant !== undefined && config.sensitiveReadGrants.includes(risk.sensitiveGrant);
}

export interface ApprovalRequest {
  /** Public challenge only; the credential response never enters AgentEvent. */
  sudo?: import('./SudoCredentials').SudoChallenge;
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
  /** Absolute target path of an escalated file write, so a client can offer to
   * trust its containing folder. */
  escalatedPath?: string;
  /** False means the capability must be approved one call at a time. Clients
   * must not offer or accept persistent "always"/"trust" actions. */
  persistable?: boolean;
  /** Present when the tool allows approving this folder for the rest of the
   * run ("Allow <folder> for this run"). Never persisted; absent for shell,
   * sudo, sensitive, and out-of-home calls. */
  runGrant?: RunGrant;
  /** Home-relative sensitive root (e.g. `~/.ssh`) an "always" answer to this
   * read would allow for the profile. Never present for writes. */
  sensitiveGrant?: string;
}

/** The folder a "trust" answer would add to the profile: the same folder a
 * run grant would cover, so trust never reaches home itself, a folder above
 * it, or a sensitive root. Undefined when the request cannot be trusted. */
export function approvalTrustFolder(request: ApprovalRequest): string | undefined {
  return request.persistable !== false && request.escalated && request.escalatedPath && !request.sudo
    ? request.runGrant?.folder
    : undefined;
}

/** A folder approved for the remainder of one run. A write grant also covers
 * reads; a read grant never covers writes. */
export interface RunGrant {
  folder: string;
  access: 'read' | 'write';
}

/** True when an earlier run grant covers this request. Only requests the tool
 * marked grantable qualify, so a grant never widens to other capabilities. */
export function coveredByRunGrant(request: ApprovalRequest, grants: readonly RunGrant[]): boolean {
  const wanted = request.runGrant;
  if (!wanted || request.sudo || !request.escalatedPath) { return false; }
  return grants.some(grant => (grant.access === 'write' || wanted.access === 'read')
    && isWithin(request.escalatedPath!, grant.folder));
}

function isWithin(target: string, folder: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The sensitive read root an "always"/"trust" answer would persist, if any. */
export function approvalSensitiveGrant(request: ApprovalRequest): string | undefined {
  return request.persistable !== false && !request.sudo ? request.sensitiveGrant : undefined;
}

export interface ApprovalDecision {
  /** Who approved: policy (no prompt) or the user. Set by the runner. */
  source?: 'policy' | 'user';
  sudoResponse?: import('./SudoCredentials').SudoResponse;
  approved: boolean;
  reason?: string;
  /** Nobody answered in time. The run stops instead of looking for another
   * route; `reason` tells the user what was left waiting. */
  unanswered?: boolean;
}

/**
 * Resolves 'ask'-mode approval requests. The CLI implements this with a
 * readline prompt; future clients bring their own UI. When no handler is
 * provided (unattended runs), 'ask' degrades to deny.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
