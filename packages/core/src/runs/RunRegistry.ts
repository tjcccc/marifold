import * as crypto from 'crypto';
import { dirname } from 'path';
import { AgentEvent, AgentUsage } from '../agent/AgentEvents';
import { AgentRunner } from '../agent/AgentRunner';
import { ApprovalDecision, ApprovalMode, ApprovalRequest, ToolKind } from '../agent/ApprovalPolicy';
import { isInsideAny } from '../agent/tools/WriteFileTool';
import { MarifoldError } from '../errors/MarifoldError';
import { TaskStatus } from '../tasks/TaskStore';

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FINISHED_RUN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_RUNS = 5;
const DEFAULT_MAX_BUFFERED_EVENTS = 10_000;
const MAX_RETAINED_FINISHED_RUNS = 50;

/** The narrow runtime slice the registry needs, so tests can fake it without a
 * full MarifoldRuntime. `MarifoldRuntime.createRunRegistry()` binds the real one. */
export interface RunRegistryRuntime {
  createAgentRunner(profile?: string): AgentRunner;
  setProfileAgentApproval(profile: string, kind: ToolKind, mode: ApprovalMode): void;
  addProfileTrustedFolder(profile: string, folder: string): string;
  defaultProfile(): string;
}

export interface RunRegistryOptions {
  runtime: RunRegistryRuntime;
  /** How long an approval prompt waits for an answer before auto-denying.
   * Matches the Telegram bridge's five-minute window by default. */
  approvalTimeoutMs?: number;
  /** How long a finished run (and its event buffer) stays queryable for
   * late/reconnecting clients before eviction. */
  finishedRunTtlMs?: number;
  maxActiveRuns?: number;
  /** Per-run event buffer cap; oldest events drop first (clients can backfill
   * from the run's durable task record). */
  maxBufferedEvents?: number;
  log?: (message: string) => void;
}

/** What a client may pass when starting a run. Mirrors the AgentRunOptions
 * surface that is safe to accept over the service boundary. */
export interface RunStartInput {
  objective: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  think?: boolean;
  instructions?: string[];
  maxIterations?: number;
  forcePlan?: boolean;
  lean?: boolean;
  cwd?: string;
}

/** Snapshot view of a run for list/get responses. `status` is the TaskStatus
 * verbatim — `running` until the terminal `done` event lands. */
export interface RunRecord {
  id: string;
  objective: string;
  profile: string;
  status: TaskStatus;
  taskId?: string;
  sessionId?: string;
  createdAt: string;
  finishedAt?: string;
  summary?: string;
  usage?: AgentUsage;
  /** Sequence number of the newest buffered event (0 = none yet). */
  eventCount: number;
  pendingApprovals: ApprovalRequest[];
}

export interface SequencedEvent {
  seq: number;
  event: AgentEvent;
}

export type RunApprovalAction = 'once' | 'always' | 'trust' | 'deny';

interface PendingApproval {
  runId: string;
  request: ApprovalRequest;
  settle: (decision: ApprovalDecision) => void;
}

interface ActiveRun {
  id: string;
  objective: string;
  profile: string;
  status: TaskStatus;
  taskId?: string;
  sessionId?: string;
  createdAt: string;
  finishedAt?: string;
  summary?: string;
  usage?: AgentUsage;
  finished: boolean;
  buffer: SequencedEvent[];
  firstSeq: number;
  lastSeq: number;
  abort: AbortController;
  steeringQueue: string[];
  grantedKinds: Set<ToolKind>;
  trustedFolders: string[];
  waiters: Array<() => void>;
  evictTimer?: NodeJS.Timeout;
}

/**
 * In-memory session state for agent runs driven across separate requests
 * (start → event stream → approval answer → cancel). The durable record lives
 * in TaskStore (`run.taskId`); this registry adds the live layer TaskStore
 * cannot hold: the abort handle, pending-approval resolution, the steering
 * queue, and a sequenced event buffer for (re)connecting subscribers.
 */
export class RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly runtime: RunRegistryRuntime;
  private readonly approvalTimeoutMs: number;
  private readonly finishedRunTtlMs: number;
  private readonly maxActiveRuns: number;
  private readonly maxBufferedEvents: number;
  private readonly log?: (message: string) => void;
  private closed = false;

  constructor(options: RunRegistryOptions) {
    this.runtime = options.runtime;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.finishedRunTtlMs = options.finishedRunTtlMs ?? DEFAULT_FINISHED_RUN_TTL_MS;
    this.maxActiveRuns = options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS;
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.log = options.log;
  }

  start(input: RunStartInput): RunRecord {
    if (this.closed) throw MarifoldError.agentRunInvalid('The run registry is shutting down.');
    this.sweepFinished();
    const active = [...this.runs.values()].filter(run => !run.finished).length;
    if (active >= this.maxActiveRuns) throw MarifoldError.runLimitExceeded(this.maxActiveRuns);

    const profile = input.profile ?? this.runtime.defaultProfile();
    const run: ActiveRun = {
      id: this.createRunId(),
      objective: input.objective,
      profile,
      status: 'running',
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      finished: false,
      buffer: [],
      firstSeq: 1,
      lastSeq: 0,
      abort: new AbortController(),
      steeringQueue: [],
      grantedKinds: new Set(),
      trustedFolders: [],
      waiters: [],
    };
    this.runs.set(run.id, run);
    // Detached pump: consume the run generator without blocking the caller,
    // the same detachment the Telegram bridge uses so an approval answer
    // arriving on a later request cannot deadlock the run.
    void this.pump(run, input).catch(error => {
      this.log?.(`Run ${run.id} pump failed: ${String(error)}`);
    });
    return this.toRecord(run);
  }

  get(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? this.toRecord(run) : undefined;
  }

  require(runId: string): RunRecord {
    const record = this.get(runId);
    if (!record) throw MarifoldError.runNotFound(runId);
    return record;
  }

  list(): RunRecord[] {
    this.sweepFinished();
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(run => this.toRecord(run));
  }

  /** Replay buffered events past `afterSeq`, then follow live ones. Returns
   * after yielding the terminal `done` event (or immediately after replay when
   * the run already finished). `signal` detaches the subscriber early. */
  async *events(runId: string, afterSeq = 0, signal?: AbortSignal): AsyncGenerator<SequencedEvent, void, unknown> {
    const run = this.runs.get(runId);
    if (!run) throw MarifoldError.runNotFound(runId);
    let next = Math.max(afterSeq + 1, run.firstSeq);
    while (true) {
      while (next <= run.lastSeq) {
        if (signal?.aborted) return;
        yield run.buffer[next - run.firstSeq];
        next += 1;
      }
      if (run.finished || signal?.aborted) return;
      await this.waitForChange(run, signal);
    }
  }

  answerApproval(runId: string, requestId: string, action: RunApprovalAction): { requestId: string; approved: boolean } {
    const run = this.runs.get(runId);
    if (!run) throw MarifoldError.runNotFound(runId);
    const entry = this.pending.get(requestId);
    if (!entry || entry.runId !== runId) throw MarifoldError.approvalNotFound(requestId);

    switch (action) {
      case 'deny':
        entry.settle({ approved: false, reason: 'denied via service' });
        return { requestId, approved: false };
      case 'trust': {
        const escalatedPath = entry.request.escalatedPath;
        if (!escalatedPath) {
          throw MarifoldError.agentRunInvalid('This approval has no escalated path to trust; use "once", "always", or "deny".');
        }
        const folder = dirname(escalatedPath);
        if (!run.trustedFolders.includes(folder)) run.trustedFolders.push(folder);
        try {
          this.runtime.addProfileTrustedFolder(run.profile, folder);
        } catch (error) {
          this.log?.(`Could not persist trusted folder: ${String(error)}`);
        }
        entry.settle({ approved: true });
        return { requestId, approved: true };
      }
      case 'always':
        run.grantedKinds.add(entry.request.kind);
        try {
          this.runtime.setProfileAgentApproval(run.profile, entry.request.kind, 'allow');
        } catch (error) {
          this.log?.(`Could not persist approval: ${String(error)}`);
        }
        entry.settle({ approved: true });
        return { requestId, approved: true };
      default: // 'once'
        entry.settle({ approved: true });
        return { requestId, approved: true };
    }
  }

  /** Queue mid-run guidance; the runner drains it before its next iteration
   * and emits a `steering` event so attached clients see it land. */
  steer(runId: string, text: string): void {
    const run = this.runs.get(runId);
    if (!run) throw MarifoldError.runNotFound(runId);
    if (run.finished) throw MarifoldError.agentRunInvalid(`Run ${runId} already finished; steering only applies to a running task.`);
    run.steeringQueue.push(text);
  }

  /** Idempotent: aborts an active run (resolving any pending approval so the
   * loop unblocks immediately) and reports the current status either way. */
  cancel(runId: string): TaskStatus {
    const run = this.runs.get(runId);
    if (!run) throw MarifoldError.runNotFound(runId);
    if (!run.finished) run.abort.abort();
    return run.status;
  }

  close(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      if (!run.finished) run.abort.abort();
      if (run.evictTimer) clearTimeout(run.evictTimer);
    }
  }

  private async pump(run: ActiveRun, input: RunStartInput): Promise<void> {
    try {
      const runner = this.runtime.createAgentRunner(input.profile);
      const events = runner.run({
        objective: input.objective,
        profile: input.profile,
        provider: input.provider,
        model: input.model,
        sessionId: input.sessionId,
        think: input.think,
        instructions: input.instructions,
        maxIterations: input.maxIterations,
        forcePlan: input.forcePlan,
        lean: input.lean,
        cwd: input.cwd,
        tags: ['service'],
        signal: run.abort.signal,
        steering: () => run.steeringQueue.splice(0),
        approvalHandler: request => this.handleApproval(run, request),
      });
      for await (const event of events) {
        this.append(run, event);
      }
      // AgentRunner always terminates with a `done` event; guard anyway.
      if (!run.finished) this.finish(run, run.status === 'running' ? 'failed' : run.status);
    } catch (error) {
      // AgentRunner catches its own errors; reaching here means the generator
      // itself blew up. Surface it on the stream and close out the run.
      this.log?.(`Run ${run.id} failed: ${String(error)}`);
      this.append(run, { type: 'error', code: 'RUN_PUMP_FAILED', message: String(error) });
      this.append(run, { type: 'done', taskId: run.taskId ?? '', status: 'failed' });
    }
  }

  private append(run: ActiveRun, event: AgentEvent): void {
    if (run.finished) return;
    if (event.type === 'status' && !run.taskId) run.taskId = event.taskId;
    run.lastSeq += 1;
    run.buffer.push({ seq: run.lastSeq, event });
    if (run.buffer.length > this.maxBufferedEvents) {
      run.buffer.splice(0, run.buffer.length - this.maxBufferedEvents);
      run.firstSeq = run.lastSeq - run.buffer.length + 1;
    }
    if (event.type === 'done') {
      run.summary = event.summary;
      run.usage = event.usage;
      this.finish(run, event.status);
    } else if (event.type === 'status') {
      run.status = event.status;
    }
    this.notify(run);
  }

  private finish(run: ActiveRun, status: TaskStatus): void {
    run.finished = true;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    // A dangling prompt would otherwise hold its timer until timeout.
    for (const [requestId, entry] of this.pending) {
      if (entry.runId === run.id) {
        this.pending.delete(requestId);
        entry.settle({ approved: false, reason: 'run finished' });
      }
    }
    run.evictTimer = setTimeout(() => {
      this.runs.delete(run.id);
    }, this.finishedRunTtlMs);
    run.evictTimer.unref?.();
    this.notify(run);
  }

  /** ApprovalHandler for the run: short-circuit on this run's session grants,
   * otherwise park the request until a client answers, the timeout fires, or
   * the run is cancelled. Mirrors TelegramBridge.requestApproval. */
  private handleApproval(run: ActiveRun, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!request.escalated && run.grantedKinds.has(request.kind)) return Promise.resolve({ approved: true });
    if (request.escalated && request.escalatedPath && isInsideAny(request.escalatedPath, run.trustedFolders)) {
      return Promise.resolve({ approved: true });
    }

    return new Promise<ApprovalDecision>(resolve => {
      const timer = setTimeout(() => {
        settle({ approved: false, reason: 'no response to the approval prompt' });
      }, this.approvalTimeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        settle({ approved: false, reason: 'run cancelled' });
      };
      const settle = (decision: ApprovalDecision): void => {
        clearTimeout(timer);
        run.abort.signal.removeEventListener('abort', onAbort);
        this.pending.delete(request.id);
        this.notify(run);
        resolve(decision);
      };
      // Cancel must unblock the runner's `await approvalHandler(...)` at once,
      // not after the timeout, so the loop can observe the abort and finish.
      run.abort.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, { runId: run.id, request, settle });
      this.notify(run);
    });
  }

  private waitForChange(run: ActiveRun, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const waiter = (): void => {
        signal?.removeEventListener('abort', waiter);
        resolve();
      };
      run.waiters.push(waiter);
      signal?.addEventListener('abort', waiter, { once: true });
    });
  }

  private notify(run: ActiveRun): void {
    for (const waiter of run.waiters.splice(0)) waiter();
  }

  private sweepFinished(): void {
    const now = Date.now();
    const finished = [...this.runs.values()]
      .filter(run => run.finished)
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
    for (const run of finished) {
      const expired = run.finishedAt !== undefined && now - Date.parse(run.finishedAt) >= this.finishedRunTtlMs;
      const overCap = finished.length - finished.indexOf(run) > MAX_RETAINED_FINISHED_RUNS;
      if (expired || overCap) {
        if (run.evictTimer) clearTimeout(run.evictTimer);
        this.runs.delete(run.id);
      }
    }
  }

  private toRecord(run: ActiveRun): RunRecord {
    return {
      id: run.id,
      objective: run.objective,
      profile: run.profile,
      status: run.status,
      taskId: run.taskId,
      sessionId: run.sessionId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      summary: run.summary,
      usage: run.usage,
      eventCount: run.lastSeq,
      pendingApprovals: [...this.pending.values()]
        .filter(entry => entry.runId === run.id)
        .map(entry => entry.request),
    };
  }

  private createRunId(): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `run_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
  }
}
