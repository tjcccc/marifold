import { ImageInput, JSONValue, ToolDefinition } from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { ToolKind } from './ApprovalPolicy';
import type { RunWorkspace } from './RunWorkspace';
import type {
  UserInputRequest,
  UserInputResponse,
  UserInputSubmission,
} from './UserInput';

export type AgentToolKind = ToolKind | 'interaction';

export interface ToolExecutionContext {
  /** Working directory the run was started from. Filesystem tools resolve
   * relative paths against it and treat it as the workspace boundary. */
  cwd: string;
  /** Extra absolute folders trusted for file writes (outside the workspace).
   * In-home entries auto-approve writes; external entries still prompt. */
  trustedFolders?: string[];
  /** Per-run filesystem/process capability set. Shell execution fails closed
   * when this is absent instead of falling back to unrestricted host access. */
  workspace?: RunWorkspace;
  signal?: AbortSignal;
  /** Cap applied to tool output before it is returned to the model. */
  outputLimit: number;
}

export interface ToolExecutionResult {
  /** Output returned to the model. */
  content: string;
  /** Images made visible to the next model iteration by an attachment tool.
   * They remain turn-local and are not embedded in the textual tool result. */
  images?: ImageInput[];
  /** Short human-readable outcome for event rendering, e.g. "1.2KB read". */
  summary?: string;
  isError?: boolean;
}

export interface ToolRiskAssessment {
  /** Hard policy denial. Unlike escalation, the user cannot approve this call. */
  blocked?: boolean;
  /** True forces interactive approval even when policy says allow. */
  escalate: boolean;
  reason?: string;
  /** True when the call targets a narrowly pre-authorized capability (for
   * example an uploaded attachment or eligible in-home trusted folder) and is
   * auto-approved regardless of the tool kind's approval mode. */
  trusted?: boolean;
  /** Absolute target path of an escalated file call, so a client can offer to
   * trust its folder. */
  targetPath?: string;
  /** False hides/rejects persistent "always"/"trust" actions. Used for host
   * paths outside $HOME and other capabilities that must be approved afresh. */
  persistable?: boolean;
}

export interface AgentTool {
  definition: ToolDefinition;
  kind: ToolKind;
  /** One-line human description of a specific call, shown in events and
   * approval prompts, e.g. "write 2.1KB to ./notes.md". */
  summarizeCall(input: Record<string, JSONValue>): string;
  /** Flag calls that exceed the tool kind's normal risk (e.g. writes outside
   * the workspace). Escalated calls always require interactive approval. */
  assessRisk?(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment;
  execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export type EffectfulAgentTool = AgentTool;

export interface UserInputAgentTool {
  definition: ToolDefinition;
  kind: 'interaction';
  summarizeCall(input: Record<string, JSONValue>): string;
  createRequest(callId: string, input: Record<string, JSONValue>): UserInputRequest;
  resolveResponse(request: UserInputRequest, submission: UserInputSubmission): UserInputResponse;
  formatResponse(response: UserInputResponse): string;
}

export type RegisteredAgentTool = AgentTool | UserInputAgentTool;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();

  register(tool: RegisteredAgentTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw MarifoldError.agentToolInvalid(`Agent tool '${tool.definition.name}' is already registered.`, tool.definition.name);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredAgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map(tool => tool.definition);
  }
}

/** Truncate tool output to the configured limit, keeping head AND tail so the
 * end of an output (often where the result/error lives) survives — more useful
 * to the agent than head-only when a large read/shell output is capped. */
export function capToolOutput(content: string, limit: number): string {
  if (limit <= 0 || content.length <= limit) return content;
  const head = Math.ceil(limit * 0.7);
  const tail = limit - head;
  const omitted = content.length - limit;
  const tailPart = tail > 0 ? `\n${content.slice(content.length - tail)}` : '';
  return `${content.slice(0, head)}\n[output truncated — ${omitted} of ${content.length} characters omitted]${tailPart}`;
}

export function requireStringInput(input: Record<string, JSONValue>, key: string, tool: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw MarifoldError.agentToolInvalid(`Tool '${tool}' requires a non-empty string '${key}' argument.`, tool);
  }
  return value;
}
