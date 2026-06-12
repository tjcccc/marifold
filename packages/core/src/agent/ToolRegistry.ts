import { JSONValue, ToolDefinition } from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { ToolKind } from './ApprovalPolicy';

export interface ToolExecutionContext {
  /** Working directory the run was started from. Filesystem tools resolve
   * relative paths against it and treat it as the workspace boundary. */
  cwd: string;
  signal?: AbortSignal;
  /** Cap applied to tool output before it is returned to the model. */
  outputLimit: number;
}

export interface ToolExecutionResult {
  /** Output returned to the model. */
  content: string;
  /** Short human-readable outcome for event rendering, e.g. "1.2KB read". */
  summary?: string;
  isError?: boolean;
}

export interface ToolRiskAssessment {
  /** True forces interactive approval even when policy says allow. */
  escalate: boolean;
  reason?: string;
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

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw MarifoldError.agentToolInvalid(`Agent tool '${tool.definition.name}' is already registered.`, tool.definition.name);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map(tool => tool.definition);
  }
}

/** Truncate tool output to the configured limit with an explicit marker. */
export function capToolOutput(content: string, limit: number): string {
  if (limit <= 0 || content.length <= limit) return content;
  return `${content.slice(0, limit)}\n[output truncated at ${limit} characters]`;
}

export function requireStringInput(input: Record<string, JSONValue>, key: string, tool: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw MarifoldError.agentToolInvalid(`Tool '${tool}' requires a non-empty string '${key}' argument.`, tool);
  }
  return value;
}
