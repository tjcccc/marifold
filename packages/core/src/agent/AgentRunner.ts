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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripMemoryControls } from '../memory/MemoryControls';
import { buildHistoryContext, HistoryTurn } from './AgentHistory';
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
import { createRunWorkspace, RunFileInput, RunWorkspace } from './RunWorkspace';
import { AgentTool, ToolExecutionContext, ToolRegistry } from './ToolRegistry';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'steps'],
};

export interface AgentRunOptions {
  objective: string;
  profile?: string;
  provider?: string;
  model?: string;
  /** Images attached to the objective. Sent to the model on the first turn
   * (priest carries them through the request, exactly like the chat path). */
  images?: ImageInput[];
  /** Preserve the attached images' original encoded bytes for this turn. */
  originalImages?: boolean;
  /** Conversation session id. When set, a single clean turn pair (the user's
   * text + the final answer) is persisted so the session can be resumed. */
  sessionId?: string;
  /** Replace this persisted user→assistant exchange in place. Later turns are
   * preserved and excluded from this run's history context. */
  replaceUserTurnIndex?: number;
  /** Text to store as the user turn on resume (e.g. the full `$skill …`
   * invocation). Defaults to `objective` when omitted. */
  userTurn?: string;
  /** Lean run (e.g. a skill): keep tools (so it can read bundled files) but skip
   * the plan and verify phases and the verbose agent framing, and ask for only
   * the final output. Cuts token cost sharply without changing the result. */
  lean?: boolean;
  /** Force a planning pass before the loop. Off by default (adaptive: the model
   * plans inline only when the task warrants it). The TUI's `/steps` sets this
   * for one turn; weak models can force it via config. */
  forcePlan?: boolean;
  /** Working directory for filesystem/shell tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Stable id used for ~/.marifold/runs/<id>. Service runs pass their public
   * run id; direct runs fall back to the task id. */
  executionId?: string;
  /** Binary files staged read-only under this run's input directory. */
  files?: RunFileInput[];
  /** Extra trusted folders for this run only, merged over the profile's.
   * In-home writes are auto-approved; external folders remain per-call
   * approval-gated. Used by channels for scratch/outbox capabilities. */
  trustedFolders?: string[];
  /** Per-run thinking-mode override (honored by think-capable providers). */
  think?: boolean;
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
  /** Normalize and optimize image inputs before the first provider request. */
  prepareImages?: (images: ImageInput[], optimize: boolean) => Promise<ImageInput[]>;
  /** Persist one clean conversation turn (objective → final answer) to the
   * session, so resuming shows the result without the raw agent framing. */
  persistTurn?: (
    sessionId: string,
    profile: string,
    userText: string,
    assistantText: string,
    images?: ImageInput[],
    replaceUserTurnIndex?: number,
  ) => Promise<void>;
  /** Load the session's clean turns (objective → answer pairs) for bounded
   * cross-objective memory on NON-lean runs. Lean/skill runs stay stateless. */
  loadRecentTurns?: (sessionId: string, beforeUserTurnIndex?: number) => HistoryTurn[];
  /** Lazily attach app-owned instructions selected from the objective (for
   * example the built-in skill-manager guide). */
  resolveBuiltInInstructions?: (objective: string, profile: string) => string[];
  /** Narrow app-owned folders that the resolved profile may inspect read-only
   * during a run, such as profile and global skill directories. */
  resolveReadOnlyFolders?: (profile: string) => string[];
}

/** Char budget for the injected history window when no profile budget is set. */
const HISTORY_BUDGET_DEFAULT_CHARS = 16000;

interface LoopState {
  mode: Exclude<AgentToolMode, 'auto'>;
  triedNativeFallback: boolean;
  exchange: ToolExchangeTurn[];      // native mode
  transcript: string[];              // control-block mode
  /** Bounded window of prior clean conversation (non-lean runs only). */
  historyContext?: string;
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
    // A skill invocation already supplies its own authoritative instructions;
    // only ordinary agent objectives receive lazily selected built-in guides.
    const builtInInstructions = options.lean
      ? []
      : (this.deps.resolveBuiltInInstructions?.(options.objective, settings.profile) ?? []);
    let runOptions: AgentRunOptions = builtInInstructions.length > 0
      ? { ...options, instructions: [...builtInInstructions, ...(options.instructions ?? [])] }
      : options;
    if (runOptions.images && this.deps.prepareImages) {
      runOptions = {
        ...runOptions,
        images: await this.deps.prepareImages(runOptions.images, runOptions.originalImages !== true),
      };
    }
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

    const workspace = createRunWorkspace({
      id: options.executionId ?? task.id,
      cwd,
      trustedFolders: [...agentConfig.trustedFolders, ...(options.trustedFolders ?? [])],
      readOnlyFolders: this.deps.resolveReadOnlyFolders?.(settings.profile),
      files: options.files,
    });
    const toolContext: ToolExecutionContext = {
      cwd: workspace.cwd,
      trustedFolders: [...agentConfig.trustedFolders, ...(options.trustedFolders ?? [])],
      workspace,
      signal: options.signal,
      outputLimit: agentConfig.toolOutputLimit,
    };
    // Bounded cross-objective memory: inject a window of the recent clean
    // session pairs so a NON-lean task can reference prior turns ("save the
    // above prompt"). Lean/skill runs stay stateless (isolated).
    const recentTurns = !options.lean && options.sessionId && this.deps.loadRecentTurns
      ? this.deps.loadRecentTurns(options.sessionId, options.replaceUserTurnIndex)
      : [];
    // Cap to the last N turns when the profile sets session_context_turns — the
    // same turn window chat uses, so the knob means the same thing in both modes.
    // The char budget (≈ the token budget) remains the secondary bound.
    const windowedTurns = settings.sessionContextTurns != null
      ? recentTurns.slice(Math.max(0, recentTurns.length - settings.sessionContextTurns))
      : recentTurns;
    const historyContext = buildHistoryContext(
      windowedTurns,
      settings.maxContextTokens ?? HISTORY_BUDGET_DEFAULT_CHARS,
    );

    const state: LoopState = {
      mode: requestedMode === 'auto' ? 'native' : requestedMode,
      triedNativeFallback: requestedMode !== 'auto',
      exchange: [],
      transcript: [],
      historyContext,
      toolSummaries: [],
      steeringNotes: [],
    };

    try {
      // Phase 1 — plan, only when forced (the TUI's `/steps`, or a weak-model
      // config). Adaptive by default: a separate planning call is overhead for
      // the common single-step task, so the model just reasons inline.
      if (options.forcePlan) {
        const plan = await this.buildPlan(engine, config, settings.profile, runOptions);
        const planned = this.deps.taskStore.update(task.id, {
          title: plan.title,
          plan: plan.steps.map((text, index) => ({
            id: `step_${index + 1}`,
            text,
            status: index === 0 ? 'in_progress' : 'pending',
          })),
        });
        yield { type: 'plan', taskId: task.id, plan: planned.plan };
      }

      // Phase 2 — tool loop
      let finalText: string | undefined;
      let iterations = 0;
      while (iterations < maxIterations) {
        iterations += 1;
        this.assertNotAborted(options.signal);
        for (const note of this.drainSteering(task.id, options, state)) {
          yield { type: 'steering', taskId: task.id, text: note };
        }

        const response = await engine.run(this.loopRequest(config, settings.profile, runOptions, state, workspace), {
          signal: options.signal,
        });

        this.trace({
          kind: 'iteration',
          iteration: iterations,
          mode: state.mode,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          // Cumulative loop context the model saw this turn (the thing that grows).
          exchangeTurns: state.exchange.length,
          exchangeChars: state.exchange.reduce((n, t) => n + (t.kind === 'tool_result' ? t.content.length : (t.text?.length ?? 0)), 0),
          transcriptChars: state.transcript.reduce((n, t) => n + t.length, 0),
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
        if (text) yield { type: 'text', text, phase: calls.length > 0 ? 'progress' : 'final' };

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

      // Persist a single clean turn pair (objective → final answer) so resuming
      // the session shows the result, not the raw `Objective:`/tool framing.
      if (options.sessionId && this.deps.persistTurn) {
        const args = [
          options.sessionId,
          settings.profile,
          options.userTurn ?? options.objective,
          finalText,
          runOptions.images,
        ] as const;
        if (options.replaceUserTurnIndex === undefined) {
          await this.deps.persistTurn(...args);
        } else {
          await this.deps.persistTurn(...args, options.replaceUserTurnIndex);
        }
      }

      // Complete. No verification phase: a separate self-grading model call was
      // non-actionable (a failed grade didn't retry or fix anything) and models
      // self-grade unreliably — so it was pure token overhead. Real checks belong
      // in tools the agent runs inside the loop, not a final self-assessment.
      this.completePlanSteps(task.id, true);
      yield* this.finish(task.id, 'completed', finalText, undefined, usage);
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
    if (risk.blocked) {
      const reason = risk.reason ?? 'blocked by the run security policy';
      yield { type: 'approval_decision', requestId: call.id, approved: false, source: 'policy', reason };
      return { approved: false, reason };
    }
    // Tools only set `trusted` for eligible in-home capabilities.
    if (risk.trusted) {
      yield { type: 'approval_decision', requestId: call.id, approved: true, source: 'policy' };
      return { approved: true };
    }
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
      ...(risk.targetPath ? { escalatedPath: risk.targetPath } : {}),
      ...(risk.persistable === false ? { persistable: false } : {}),
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

  /**
   * Opt-in diagnostic trace for agent-mode context cost (off by default).
   * Set `MARIFOLD_AGENT_TRACE=1` to append JSONL to ~/.marifold/agent-trace.jsonl,
   * or `MARIFOLD_AGENT_TRACE=<path>` for a custom file. Captures per-iteration
   * input tokens + cumulative loop-context size and per-tool-result sizes, so we
   * can see whether huge results or many small steps drive the growth. Never
   * throws — tracing must not affect a run.
   */
  private trace(record: Record<string, unknown>): void {
    const target = process.env.MARIFOLD_AGENT_TRACE;
    if (!target) return;
    try {
      const file = target === '1' || target === 'true'
        ? path.join(os.homedir(), '.marifold', 'agent-trace.jsonl')
        : target;
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch {
      // Diagnostics are best-effort; a trace failure must never break a run.
    }
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
    this.trace({ kind: 'tool_result', tool: call.name, chars: content.length, isError });
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

  /** Drain any `/btw` steering the caller queued and record it for the next
   * turn. Returns the drained notes so the run generator can surface each as a
   * `steering` event to attached clients. */
  private drainSteering(taskId: string, options: AgentRunOptions, state: LoopState): string[] {
    if (!options.steering) return [];
    const drained: string[] = [];
    for (const note of options.steering()) {
      const text = note.trim();
      if (!text) continue;
      state.steeringNotes.push(text);
      drained.push(text);
      this.deps.taskStore.appendEvent(taskId, { kind: 'note', message: `Steering: ${text}` });
    }
    return drained;
  }

  private loopRequest(
    config: PriestConfig,
    profile: string,
    options: AgentRunOptions,
    state: LoopState,
    workspace: RunWorkspace,
  ): PriestRequest {
    // Attach the objective's images on the first turn only (before any tool
    // exchange/transcript accrues), so the model sees them without re-uploading
    // on every iteration.
    const firstTurn = state.exchange.length === 0 && state.transcript.length === 0;
    const base: PriestRequest = {
      config,
      profile,
      prompt: options.lean
        ? options.objective
        : `Objective: ${options.objective}\n\nUse tools only when the objective genuinely requires reading or writing files, running commands, searching the web, or delegating. Many objectives — greetings, questions, explanations, drafting text — need no tools at all; for those, answer directly from your own knowledge. Do not invent tool calls. When the objective is complete, reply with a short final answer describing the outcome.`,
      context: this.agentContext(state, workspace, options.instructions, options.lean),
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

  private agentContext(state: LoopState, workspace: RunWorkspace, instructions?: string[], lean = false): string[] {
    const files = workspace.files.length > 0
      ? `Read-only input files:\n${workspace.files.map(file => `- ${file.name}: ${file.path}`).join('\n')}`
      : 'No binary input files were staged for this run.';
    const workspaceContext = [
      `Working directory: ${workspace.cwd}. Relative tool paths resolve against it.`,
      `Isolated run directory: ${workspace.rootDir}. ~ is the isolated run home (${workspace.homeDir}), not the user's real home.`,
      `${files}\nWrite files intended for the user to ${workspace.outputDir}. Temporary scripts and environments belong in ${workspace.workDir}.`,
      'shell_exec has no network access and cannot mutate host system/global package directories. Use python_package_install for approved Python dependencies; it installs only into this run’s disposable uv environment.',
    ].join('\n');
    // Lean run (skills): minimal framing — the instructions are authoritative,
    // and we ask for only the final output to avoid plan/preamble/reasoning prose.
    if (lean) {
      const context = [...(instructions ?? [])];
      context.push(
        `${workspaceContext}\nUse read_file only if the instructions reference a bundled file (e.g. vars.toml); resolve it, then reply with ONLY the final output the instructions define — no plan, preamble, reasoning, or commentary.`,
      );
      if (state.mode === 'control-block') {
        context.push(buildControlBlockInstructions(this.deps.registry.definitions()));
      }
      return context;
    }
    const context = [
      'You are running as the Marifold agent. Stay focused on the stated objective and keep replies concise.',
      'Prefer answering directly. Reach for a tool only when the objective cannot be completed from your own knowledge — never use a tool just to demonstrate one.',
      workspaceContext,
    ];
    // Skill instructions are authoritative for this run — lead with them.
    if (instructions?.length) context.unshift(...instructions);
    // Bounded prior-conversation memory (non-lean only) so the objective can
    // reference earlier turns. Placed after framing, before tool instructions.
    if (state.historyContext) context.push(state.historyContext);
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
  if (usage.cachedInputTokens != null) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens;
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
