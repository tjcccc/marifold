import {
  ImageInput,
  JSONValue,
  PriestConfig,
  PriestRequest,
  PriestResponse,
  ToolCall,
  ToolExchangeTurn,
  UsageInfo,
} from '@priest-ai/core';
import * as crypto from 'crypto';
import { stripMemoryControls } from '../memory/MemoryControls';
import { MarifoldResolvedSettings, MarifoldRunRequest } from '../runtime/MarifoldTypes';
import { TaskState, TaskStatus, TaskStore } from '../tasks/TaskStore';
import { AgentEvent, AgentUsage } from './AgentEvents';
import {
  AgentToolMode,
  ApprovalHandler,
  ApprovalRequest,
  MarifoldAgentConfig,
} from './ApprovalPolicy';
import {
  buildControlBlockInstructions,
  formatControlBlockResult,
  parseControlBlockCalls,
} from './ControlBlockTools';
import { AgentTool, ToolExecutionContext, ToolRegistry } from './ToolRegistry';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'steps'],
};

const VERIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['passed', 'notes'],
};

export interface AgentRunOptions {
  objective: string;
  profile?: string;
  provider?: string;
  model?: string;
  /** Images attached to the objective. Sent to the model on the first turn
   * (priest carries them through the request, exactly like the chat path). */
  images?: ImageInput[];
  /** Conversation session id. When set, the main loop turns persist to and read
   * from the priest session, so the agent remembers earlier turns. */
  sessionId?: string;
  /** Working directory for filesystem/shell tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Authoritative instructions (e.g. a skill body) injected at the top of the
   * system prompt for every loop turn, so the run is guided by them. */
  instructions?: string[];
  /** Resolves 'ask' approvals. Absent (unattended runs): 'ask' degrades to deny. */
  approvalHandler?: ApprovalHandler;
  signal?: AbortSignal;
  maxIterations?: number;
  toolMode?: AgentToolMode;
  /** Extra tags stored on the task (e.g. 'scheduled'). */
  tags?: string[];
  /**
   * Mid-run steering hook (the TUI's `/btw`). Called once between loop
   * iterations; returns any text the user injected since the last drain (and
   * should clear that queue). The notes are surfaced to the model as extra
   * guidance on the next turn so a running task adapts without cancelling.
   */
  steering?: () => string[];
  /** Unattended run (scheduled tasks): applies [agent.unattended] approval
   * overrides; with no approvalHandler present, 'ask' degrades to deny. */
  unattended?: boolean;
}

/** The slice of PriestEngine the agent loop needs. */
export interface AgentEngine {
  run(request: PriestRequest, options?: { signal?: AbortSignal }): Promise<PriestResponse>;
}

export interface AgentEngineContext {
  engine: AgentEngine;
  config: PriestConfig;
}

export interface AgentRunnerDeps {
  taskStore: TaskStore;
  registry: ToolRegistry;
  agentConfig: MarifoldAgentConfig;
  resolveSettings: (request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model'>) => MarifoldResolvedSettings;
  prepareEngine: (settings: MarifoldResolvedSettings) => Promise<AgentEngineContext>;
}

interface LoopState {
  mode: Exclude<AgentToolMode, 'auto'>;
  triedNativeFallback: boolean;
  exchange: ToolExchangeTurn[];      // native mode
  transcript: string[];              // control-block mode
  toolSummaries: string[];
  /** Mid-run `/btw` guidance, surfaced to the model via userContext. */
  steeringNotes: string[];
}

/**
 * Approval-aware agent loop. Plans, iterates tool calls against the
 * ToolRegistry, verifies, and summarizes — persisting progress into the
 * ephemeral TaskStore. Task state is never promoted into profile memory, and
 * the chat memory pipeline is bypassed entirely: hidden memory control blocks
 * in model output are stripped and their payloads discarded.
 *
 * Events are delivered as an AsyncGenerator so renderers get backpressure and
 * cancellation for free. v0.11 emits one text event per model turn; a future
 * upgrade to SDK streamEvents can add live deltas without changing the event
 * contract.
 */
export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const agentConfig = this.deps.agentConfig;
    const settings = this.deps.resolveSettings(options);
    const { engine: rawEngine, config } = await this.deps.prepareEngine(settings);
    // Tally token usage across every model call (plan, loop turns, verify).
    const usage: AgentUsage = {};
    const engine = withUsageTally(rawEngine, usage);
    const cwd = options.cwd ?? process.cwd();
    const maxIterations = Math.max(1, options.maxIterations ?? agentConfig.maxIterations);
    const requestedMode = options.toolMode ?? agentConfig.toolMode;

    const task = this.deps.taskStore.create({
      objective: options.objective,
      profile: settings.profile,
      tags: ['agent', ...(options.tags ?? [])],
    });
    yield { type: 'status', taskId: task.id, status: 'running' };

    const toolContext: ToolExecutionContext = {
      cwd,
      signal: options.signal,
      outputLimit: agentConfig.toolOutputLimit,
    };
    const state: LoopState = {
      mode: requestedMode === 'auto' ? 'native' : requestedMode,
      triedNativeFallback: requestedMode !== 'auto',
      exchange: [],
      transcript: [],
      toolSummaries: [],
      steeringNotes: [],
    };

    try {
      // Phase 1 — plan
      const plan = await this.buildPlan(engine, config, settings.profile, options);
      const planned = this.deps.taskStore.update(task.id, {
        title: plan.title,
        plan: plan.steps.map((text, index) => ({
          id: `step_${index + 1}`,
          text,
          status: index === 0 ? 'in_progress' : 'pending',
        })),
      });
      yield { type: 'plan', taskId: task.id, plan: planned.plan };

      // Phase 2 — tool loop
      let finalText: string | undefined;
      let iterations = 0;
      while (iterations < maxIterations) {
        iterations += 1;
        this.assertNotAborted(options.signal);
        this.drainSteering(task.id, options, state);

        const response = await engine.run(this.loopRequest(config, settings.profile, options, state), {
          signal: options.signal,
        });

        if (!response.ok) {
          if (this.shouldFallBackToControlBlocks(response, state)) {
            state.mode = 'control-block';
            state.triedNativeFallback = true;
            this.deps.taskStore.appendEvent(task.id, {
              kind: 'decision',
              message: 'Provider rejected native tool calling; switching to control-block tool mode.',
            });
            continue;
          }
          if (response.error?.code === 'REQUEST_ABORTED') throw new AbortedError();
          yield { type: 'error', code: response.error?.code ?? 'PROVIDER_ERROR', message: response.error?.message ?? 'Provider call failed.' };
          yield* this.finish(task.id, 'failed', undefined, 'Retry the run once the provider issue is resolved.', usage);
          return;
        }

        const { text, calls } = this.extractTurn(response, state);
        if (text) yield { type: 'text', text };

        if (calls.length === 0) {
          finalText = text;
          break;
        }

        if (state.mode === 'native') {
          state.exchange.push({ kind: 'assistant', text, toolCalls: calls });
        } else if (text || calls.length > 0) {
          state.transcript.push(`Assistant reply:\n${text || '(tool calls only)'}`);
        }

        for (const call of calls) {
          this.assertNotAborted(options.signal);
          yield* this.executeCall(task.id, call, options, state, toolContext);
        }
      }

      if (finalText === undefined) {
        this.deps.taskStore.appendEvent(task.id, {
          kind: 'blocker',
          message: `Iteration cap of ${maxIterations} reached before the objective was completed.`,
        });
        yield* this.finish(task.id, 'failed', 'Stopped at the iteration cap before completing the objective.', 'Re-run with a higher iteration cap or a narrower objective.', usage);
        return;
      }

      // Phase 3 — verification
      this.assertNotAborted(options.signal);
      const verification = await this.verify(engine, config, settings.profile, options, state, finalText);
      yield { type: 'verification', passed: verification.passed, notes: verification.notes };
      this.deps.taskStore.appendEvent(task.id, {
        kind: 'verification',
        message: `${verification.passed ? 'Passed' : 'Not confirmed'}: ${verification.notes}`,
      });

      // Phase 4 — summary
      const status: TaskStatus = verification.passed ? 'completed' : 'blocked';
      this.completePlanSteps(task.id, verification.passed);
      yield* this.finish(
        task.id,
        status,
        finalText,
        verification.passed ? undefined : verification.notes,
        usage,
      );
    } catch (error) {
      if (error instanceof AbortedError || (options.signal?.aborted ?? false)) {
        this.deps.taskStore.appendEvent(task.id, { kind: 'note', message: 'Run cancelled by the user.' });
        yield* this.finish(task.id, 'cancelled', undefined, 'Resume by starting a new run with the same objective.', usage);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', code: 'AGENT_RUN_ERROR', message };
      yield* this.finish(task.id, 'failed', undefined, message, usage);
    }
  }

  private async *executeCall(
    taskId: string,
    call: ToolCall,
    options: AgentRunOptions,
    state: LoopState,
    toolContext: ToolExecutionContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      const message = `Unknown tool '${call.name}'. Available tools: ${this.deps.registry.list().map(t => t.definition.name).join(', ')}.`;
      yield { type: 'tool_result', callId: call.id, tool: call.name, summary: `unknown tool '${call.name}'`, isError: true };
      this.recordToolResult(taskId, state, call, message, true, `unknown tool '${call.name}'`);
      return;
    }

    const summary = tool.summarizeCall(call.arguments);
    yield {
      type: 'tool_request',
      call: { id: call.id, tool: call.name, kind: tool.kind, input: call.arguments, summary },
    };

    const decision = yield* this.resolveApproval(call, tool, summary, options, toolContext);
    if (!decision.approved) {
      const message = `Tool call denied${decision.reason ? `: ${decision.reason}` : '.'}`;
      yield { type: 'tool_result', callId: call.id, tool: call.name, summary: 'denied', isError: true };
      this.deps.taskStore.appendEvent(taskId, { kind: 'decision', message: `Denied ${summary}${decision.reason ? ` (${decision.reason})` : ''}` });
      this.recordToolResult(taskId, state, call, message, true, 'denied', false);
      return;
    }

    let content: string;
    let isError = false;
    let resultSummary = summary;
    try {
      const result = await tool.execute(call.arguments, toolContext);
      content = result.content;
      isError = result.isError ?? false;
      resultSummary = result.summary ?? summary;
    } catch (error) {
      content = `Tool '${call.name}' failed: ${error instanceof Error ? error.message : String(error)}`;
      isError = true;
      resultSummary = `${summary} failed`;
    }

    yield { type: 'tool_result', callId: call.id, tool: call.name, summary: resultSummary, isError };
    this.recordToolResult(taskId, state, call, content, isError, resultSummary);
  }

  private async *resolveApproval(
    call: ToolCall,
    tool: AgentTool,
    summary: string,
    options: AgentRunOptions,
    toolContext: ToolExecutionContext,
  ): AsyncGenerator<AgentEvent, { approved: boolean; reason?: string }, unknown> {
    const risk = tool.assessRisk?.(call.arguments, toolContext) ?? { escalate: false };
    const approval = options.unattended
      ? { ...this.deps.agentConfig.approval, ...(this.deps.agentConfig.unattended ?? {}) }
      : this.deps.agentConfig.approval;
    let mode = approval[tool.kind];
    if (risk.escalate && mode === 'allow') mode = 'ask';

    if (mode === 'allow') {
      yield { type: 'approval_decision', requestId: call.id, approved: true, source: 'policy' };
      return { approved: true };
    }
    if (mode === 'deny') {
      yield { type: 'approval_decision', requestId: call.id, approved: false, source: 'policy', reason: `${tool.kind} tools are denied by policy` };
      return { approved: false, reason: `${tool.kind} tools are denied by policy` };
    }

    if (!options.approvalHandler) {
      const reason = 'approval required but the run is unattended';
      yield { type: 'approval_decision', requestId: call.id, approved: false, source: 'policy', reason };
      return { approved: false, reason };
    }

    const request: ApprovalRequest = {
      id: call.id,
      tool: call.name,
      kind: tool.kind,
      summary,
      input: call.arguments,
      escalated: risk.escalate,
      ...(risk.reason ? { escalationReason: risk.reason } : {}),
    };
    yield { type: 'approval_request', request };
    const decision = await options.approvalHandler(request);
    yield {
      type: 'approval_decision',
      requestId: call.id,
      approved: decision.approved,
      source: 'user',
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
    return decision;
  }

  private recordToolResult(
    taskId: string,
    state: LoopState,
    call: ToolCall,
    content: string,
    isError: boolean,
    summary: string,
    appendObservation = true,
  ): void {
    if (state.mode === 'native') {
      state.exchange.push({ kind: 'tool_result', toolCallId: call.id, name: call.name, content, isError });
    } else {
      state.transcript.push(formatControlBlockResult(call, content, isError));
    }
    state.toolSummaries.push(`${isError ? '[error] ' : ''}${summary}`);
    if (appendObservation) {
      this.deps.taskStore.appendEvent(taskId, {
        kind: 'observation',
        message: summary,
        metadata: { tool: call.name, ...(isError ? { error: 'true' } : {}) },
      });
    }
  }

  /** Drain any `/btw` steering the caller queued and record it for the next turn. */
  private drainSteering(taskId: string, options: AgentRunOptions, state: LoopState): void {
    if (!options.steering) return;
    for (const note of options.steering()) {
      const text = note.trim();
      if (!text) continue;
      state.steeringNotes.push(text);
      this.deps.taskStore.appendEvent(taskId, { kind: 'note', message: `Steering: ${text}` });
    }
  }

  private loopRequest(
    config: PriestConfig,
    profile: string,
    options: AgentRunOptions,
    state: LoopState,
  ): PriestRequest {
    // Attach the objective's images on the first turn only (before any tool
    // exchange/transcript accrues), so the model sees them without re-uploading
    // on every iteration.
    const firstTurn = state.exchange.length === 0 && state.transcript.length === 0;
    const base: PriestRequest = {
      config,
      profile,
      prompt: `Objective: ${options.objective}\n\nUse tools only when the objective genuinely requires reading or writing files, running commands, searching the web, or delegating. Many objectives — greetings, questions, explanations, drafting text — need no tools at all; for those, answer directly from your own knowledge. Do not invent tool calls. When the objective is complete, reply with a short final answer describing the outcome.`,
      context: this.agentContext(state, options.cwd ?? process.cwd(), options.instructions),
      ...(options.sessionId ? { session: { id: options.sessionId, createIfMissing: true } } : {}),
      ...(firstTurn && options.images && options.images.length > 0 ? { images: options.images } : {}),
    };
    const steering = state.steeringNotes.map(
      note => `The user added this guidance while you were working — take it into account: ${note}`,
    );
    if (state.mode === 'native') {
      return {
        ...base,
        tools: this.deps.registry.definitions(),
        toolExchange: state.exchange,
        ...(steering.length > 0 ? { userContext: steering } : {}),
      };
    }
    return {
      ...base,
      userContext: [...state.transcript, ...steering],
    };
  }

  private agentContext(state: LoopState, cwd: string, instructions?: string[]): string[] {
    const context = [
      'You are running as the Marifold agent. Stay focused on the stated objective and keep replies concise.',
      'Prefer answering directly. Reach for a tool only when the objective cannot be completed from your own knowledge — never use a tool just to demonstrate one.',
      `Working directory: ${cwd}. Relative tool paths resolve against it; ~ means the user's home directory.`,
    ];
    // Skill instructions are authoritative for this run — lead with them.
    if (instructions?.length) context.unshift(...instructions);
    if (state.mode === 'control-block') {
      context.push(buildControlBlockInstructions(this.deps.registry.definitions()));
    }
    return context;
  }

  private extractTurn(response: PriestResponse, state: LoopState): { text: string; calls: ToolCall[] } {
    // Memory control blocks are stripped and their payloads discarded — agent
    // runs never write profile memory (see docs/architecture.md).
    const stripped = stripMemoryControls(response.text ?? '');
    if (state.mode === 'native') {
      return { text: stripped.text.trim(), calls: response.toolCalls ?? [] };
    }
    const parsed = parseControlBlockCalls(stripped.text);
    // Re-id calls so they stay unique across loop iterations.
    const calls = parsed.calls.map(call => ({ ...call, id: `call_${crypto.randomBytes(4).toString('hex')}` }));
    return { text: parsed.visibleText, calls };
  }

  private shouldFallBackToControlBlocks(response: PriestResponse, state: LoopState): boolean {
    if (state.mode !== 'native' || state.triedNativeFallback) return false;
    if (response.error?.code !== 'PROVIDER_ERROR') return false;
    return /tool/i.test(response.error.message);
  }

  private async buildPlan(
    engine: AgentEngine,
    config: PriestConfig,
    profile: string,
    options: AgentRunOptions,
  ): Promise<{ title: string; steps: string[] }> {
    const fallback = {
      title: options.objective.split(/\r?\n/)[0]?.slice(0, 80) ?? 'Agent task',
      steps: ['Work toward the objective.'],
    };
    const response = await engine.run({
      config,
      profile,
      prompt: `Objective: ${options.objective}\n\nCreate a short execution plan for this objective. Reply with JSON {"title": string, "steps": string[]} using at most 5 short steps.`,
      context: ['You are planning an agent task. Reply with JSON only.'],
      output: { jsonSchema: PLAN_SCHEMA, jsonSchemaName: 'agent_plan' },
    }, { signal: options.signal });
    if (!response.ok) {
      if (response.error?.code === 'REQUEST_ABORTED') throw new AbortedError();
      return fallback;
    }

    const parsed = parseJsonObject(response.text ?? '');
    const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallback.title;
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0).slice(0, 5)
      : [];
    return { title, steps: steps.length > 0 ? steps : fallback.steps };
  }

  private async verify(
    engine: AgentEngine,
    config: PriestConfig,
    profile: string,
    options: AgentRunOptions,
    state: LoopState,
    finalText: string,
  ): Promise<{ passed: boolean; notes: string }> {
    const work = state.toolSummaries.length > 0 ? state.toolSummaries.map(s => `- ${s}`).join('\n') : '(no tools were used)';
    const response = await engine.run({
      config,
      profile,
      prompt: `Objective: ${options.objective}\n\nWork performed:\n${work}\n\nFinal answer:\n${finalText}\n\nWas the objective achieved? Reply with JSON {"passed": boolean, "notes": string}.`,
      context: [
        'You are verifying an agent task outcome. Reply with JSON only.',
        'Judge only whether the final outcome satisfies the objective. Do not judge style, efficiency, or whether a different approach would have been better. If the objective was achieved, passed must be true. Set passed to false only when the outcome is missing, wrong, or incomplete.',
        'For conversational objectives (greetings, questions, explanations), an appropriate direct reply fully satisfies the objective — no tool use or file output is required.',
      ],
      output: { jsonSchema: VERIFICATION_SCHEMA, jsonSchemaName: 'agent_verification' },
    }, { signal: options.signal });
    if (!response.ok) {
      if (response.error?.code === 'REQUEST_ABORTED') throw new AbortedError();
      return { passed: false, notes: `Verification call failed: ${response.error?.message ?? 'unknown error'}` };
    }
    const parsed = parseJsonObject(response.text ?? '');
    return {
      passed: parsed?.passed === true,
      notes: typeof parsed?.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : 'No verification notes.',
    };
  }

  private completePlanSteps(taskId: string, passed: boolean): void {
    if (!passed) return;
    const task = this.deps.taskStore.get(taskId);
    if (!task) return;
    this.deps.taskStore.update(taskId, {
      plan: task.plan.map(step => ({ id: step.id, text: step.text, status: 'completed' as const })),
    });
  }

  private async *finish(
    taskId: string,
    status: TaskStatus,
    summary?: string,
    nextAction?: string,
    usage?: AgentUsage,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const updated: TaskState = this.deps.taskStore.update(taskId, {
      status,
      ...(summary ? { summary: truncate(summary, 2000) } : {}),
      ...(nextAction ? { nextAction: truncate(nextAction, 500) } : {}),
    });
    yield { type: 'status', taskId, status: updated.status };
    yield {
      type: 'done',
      taskId,
      status: updated.status,
      ...(updated.summary ? { summary: updated.summary } : {}),
      ...(usage && hasUsage(usage) ? { usage } : {}),
    };
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AbortedError();
  }
}

class AbortedError extends Error {
  constructor() {
    super('Agent run aborted.');
    this.name = 'AbortedError';
  }
}

function parseJsonObject(text: string): Record<string, JSONValue> | undefined {
  const candidates = [text.trim()];
  const match = text.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JSONValue;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, JSONValue>;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/** Wrap an engine so each model call's token usage accrues into `total`. */
function withUsageTally(engine: AgentEngine, total: AgentUsage): AgentEngine {
  return {
    run: async (request, options) => {
      const response = await engine.run(request, options);
      addUsage(total, response.usage);
      return response;
    },
  };
}

function addUsage(total: AgentUsage, usage?: UsageInfo): void {
  if (!usage) return;
  if (usage.inputTokens != null) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  if (usage.outputTokens != null) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  const turnTotal = usage.totalTokens ?? sumDefined(usage.inputTokens, usage.outputTokens);
  if (turnTotal != null) total.totalTokens = (total.totalTokens ?? 0) + turnTotal;
  if (usage.estimatedCostUSD != null) total.estimatedCostUSD = (total.estimatedCostUSD ?? 0) + usage.estimatedCostUSD;
}

function sumDefined(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function hasUsage(usage: AgentUsage): boolean {
  return usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null || usage.estimatedCostUSD != null;
}
