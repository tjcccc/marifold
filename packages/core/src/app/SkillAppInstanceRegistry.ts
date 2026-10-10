import { randomUUID } from 'crypto';
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from '../agent/ApprovalPolicy';
import {
  normalizeUserInputSubmission,
  type UserInputHandler,
  type UserInputRequest,
  type UserInputSubmission,
} from '../agent/UserInput';
import { MarifoldError } from '../errors/MarifoldError';
import {
  appendHistory,
  clearOutput,
  cloneExecution,
  cloneSnapshot,
  committedEffectResult,
  markOutputFresh,
  markOutputStale,
  operationInputStates,
  operationInputText,
  operationIsRunnable,
  validateAttachments,
  validateSelectValue,
} from './SkillAppInstanceSupport';
import type {
  SkillAppAttachmentInput,
  SkillAppDefinition,
  SkillAppExecutionSnapshot,
  SkillAppEffect,
  SkillAppHistoryTurn,
  SkillAppInstanceSnapshot,
  SkillAppMutationResult,
  SkillAppOperationDefinition,
  SkillAppResult,
  SkillAppStateValue,
  SkillAppTriggerDefinition,
} from './SkillAppSchema';

const DEFAULT_MAX_INSTANCES = 128;
const DEFAULT_INSTANCE_RETENTION_MS = 30 * 60 * 1000;

export interface SkillAppInstanceRuntime {
  getApp(name: string): SkillAppDefinition | undefined;
  runSkillAppOperation(
    appName: string,
    operationName: string,
    state: Record<string, SkillAppStateValue>,
    signal?: AbortSignal,
    history?: SkillAppHistoryTurn[],
    attachments?: SkillAppAttachmentInput[],
    interactions?: SkillAppInteractionHandlers,
  ): Promise<SkillAppResult>;
}

export interface SkillAppInteractionHandlers {
  approvalHandler: ApprovalHandler;
  userInputHandler: UserInputHandler;
  effectHandler?: (effect: SkillAppEffect) => void;
}

export type SkillAppApprovalAction = 'once' | 'deny';

interface ActiveOperation {
  generation: number;
  controller?: AbortController;
  timer?: NodeJS.Timeout;
  resolve?: (result: SkillAppMutationResult) => void;
}

interface ActiveExecution {
  id: string;
  controller: AbortController;
  pendingApproval?: { request: ApprovalRequest; settle: (decision: ApprovalDecision) => void };
  pendingUserInput?: { request: UserInputRequest; settle: (submission: UserInputSubmission | undefined) => void };
  /** Settles with the terminal snapshot; the blocking operation route awaits it. */
  terminal: Promise<SkillAppExecutionSnapshot>;
  settleTerminal: (snapshot: SkillAppExecutionSnapshot) => void;
  /** Automatic triggers owed by edits the start request carried. */
  deferredTriggers?: SkillAppTriggerDefinition[];
}

interface InstanceRecord {
  definition: SkillAppDefinition;
  snapshot: SkillAppInstanceSnapshot;
  operations: Map<string, ActiveOperation>;
  historyByProfile: Map<string, SkillAppHistoryTurn[]>;
  attachmentsByState: Map<string, SkillAppAttachmentInput[]>;
  execution?: ActiveExecution;
  expiryTimer?: NodeJS.Timeout;
}

/** Ephemeral service-owned state for declarative SkillApp bindings/triggers.
 * Button runs use one exclusive, cancellable execution per instance; automatic
 * triggers keep the latest-wins path so typing can supersede them. */
export class SkillAppInstanceRegistry {
  private readonly instances = new Map<string, InstanceRecord>();

  constructor(
    private readonly runtime: SkillAppInstanceRuntime,
    private readonly maxInstances = DEFAULT_MAX_INSTANCES,
    private readonly retentionMs = DEFAULT_INSTANCE_RETENTION_MS,
  ) {}

  create(appName: string): SkillAppInstanceSnapshot {
    if (this.instances.size >= this.maxInstances) {
      throw MarifoldError.appInvalid(`Too many active SkillApp instances (limit ${this.maxInstances}).`);
    }
    const definition = this.runtime.getApp(appName);
    if (!definition) { throw MarifoldError.appNotFound(appName); }
    const id = `app_${randomUUID()}`;
    const snapshot: SkillAppInstanceSnapshot = {
      id,
      appName,
      state: Object.fromEntries(definition.states.map(item => [item.name, item.initial])),
      attachments: Object.fromEntries((definition.attachmentStates ?? []).map(item => [item.name, []])),
    };
    const record: InstanceRecord = {
      definition,
      snapshot,
      operations: new Map(),
      historyByProfile: new Map(),
      attachmentsByState: new Map((definition.attachmentStates ?? []).map(item => [item.name, []])),
    };
    this.instances.set(id, record);
    this.refreshExpiry(record);
    return cloneSnapshot(snapshot);
  }

  get(instanceId: string): SkillAppInstanceSnapshot {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
    return cloneSnapshot(record.snapshot);
  }

  async update(
    instanceId: string,
    values: Record<string, unknown>,
  ): Promise<SkillAppMutationResult> {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
    this.assertIdle(record);
    const changed = this.applyValues(record, values);
    if (changed.length === 0) { return { status: 'idle', instance: cloneSnapshot(record.snapshot) }; }
    const triggers = record.definition.triggers.filter(trigger =>
      trigger.onChange.some(name => changed.includes(name)));
    const missingOperations = record.definition.operations.filter(operation =>
      operationInputStates(operation).some(name => changed.includes(name))
      && !operationIsRunnable(operation.requiredInputs, record.snapshot.state));
    const runnableTriggers = triggers.filter(trigger => {
      const operation = this.requireOperation(record, trigger.operation);
      return operationIsRunnable(operation.requiredInputs, record.snapshot.state);
    });
    if (runnableTriggers.length === 0) {
      return {
        status: 'idle',
        ...(missingOperations.length > 0 ? { reason: 'missing_required_input' as const } : {}),
        ...(missingOperations.length === 1 ? { operation: missingOperations[0]!.name } : {}),
        instance: cloneSnapshot(record.snapshot),
      };
    }
    const results = await Promise.all(runnableTriggers.map(trigger => this.schedule(record, trigger)));
    const completed = [...results].reverse().find(result => result.status === 'completed');
    const selected = completed ?? results[results.length - 1];
    return {
      status: selected.status,
      ...(selected.operation ? { operation: selected.operation } : {}),
      instance: cloneSnapshot(record.snapshot),
      ...(selected.result ? { result: selected.result } : {}),
    };
  }

  /** Start a button-bound operation as a cancellable execution and return
   * immediately. `values` carries the renderer's latest editable state so a
   * run never reads input that a debounced state update has not delivered yet;
   * it is validated exactly like `update()` but fires no automatic triggers. */
  start(
    instanceId: string,
    operationName: string,
    values: Record<string, unknown> = {},
  ): SkillAppMutationResult {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
    this.assertIdle(record);
    const operation = this.requireOperation(record, operationName);
    const changed = this.applyValues(record, values);
    if (!operationIsRunnable(operation.requiredInputs, record.snapshot.state)) {
      markOutputStale(record.snapshot, operation.output);
      this.cancelOperation(record, operationName);
      return {
        status: 'idle',
        reason: 'missing_required_input',
        operation: operationName,
        instance: cloneSnapshot(record.snapshot),
      };
    }
    // A button run replaces any pending or in-flight automatic run of the same
    // operation, so a late trigger result cannot overwrite it.
    this.cancelOperation(record, operationName);
    clearOutput(record.snapshot, operation.output);
    this.startExecution(record, operation);
    // Edits carried by this start still owe their automatic triggers; they run
    // once the execution ends (inputs are locked meanwhile).
    record.execution!.deferredTriggers = record.definition.triggers.filter(trigger =>
      trigger.operation !== operationName && trigger.onChange.some(name => changed.includes(name)));
    return {
      status: 'running',
      operation: operationName,
      instance: cloneSnapshot(record.snapshot),
    };
  }

  /** Blocking compatibility form of `start()`. Ordinary operations resolve
   * when their execution finishes (`superseded` when cancelled); interactive
   * operations return `running` at once because they may wait for the user. */
  async run(instanceId: string, operationName: string): Promise<SkillAppMutationResult> {
    const started = this.start(instanceId, operationName);
    const record = this.require(instanceId);
    const operation = this.requireOperation(record, operationName);
    if (started.status !== 'running' || operation.interactive || !record.execution) { return started; }
    const terminal = await record.execution.terminal;
    if (terminal.phase === 'cancelled') {
      return { status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) };
    }
    return {
      status: 'completed',
      operation: operationName,
      instance: cloneSnapshot(record.snapshot),
      ...(terminal.result ? { result: terminal.result } : {}),
    };
  }

  updateAttachments(
    instanceId: string,
    stateName: string,
    attachments: SkillAppAttachmentInput[],
  ): SkillAppMutationResult {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
    this.assertIdle(record);
    if (!(record.definition.attachmentStates ?? []).some(state => state.name === stateName)) {
      throw MarifoldError.appInvalid(`SkillApp received unknown attachment state '${stateName}'.`);
    }
    const normalized = validateAttachments(attachments);
    record.attachmentsByState.set(stateName, normalized);
    record.snapshot.attachments = {
      ...(record.snapshot.attachments ?? {}),
      [stateName]: normalized.map(({ name, mediaType, size, kind }) => ({ name, mediaType, size, kind })),
    };
    for (const operation of record.definition.operations.filter(candidate => candidate.attachments === stateName)) {
      markOutputStale(record.snapshot, operation.output);
      this.cancelOperation(record, operation.name);
    }
    return { status: 'idle', instance: cloneSnapshot(record.snapshot) };
  }

  answerUserInput(
    instanceId: string,
    executionId: string,
    value: unknown,
  ): SkillAppInstanceSnapshot {
    const record = this.require(instanceId);
    const execution = this.requireExecution(record, executionId);
    const pending = execution.pendingUserInput;
    if (!pending) { throw MarifoldError.userInputNotFound(executionId); }
    const submission = normalizeUserInputSubmission(pending.request, value);
    execution.pendingUserInput = undefined;
    this.setExecutionPhase(record, executionId, 'running');
    pending.settle(submission);
    this.refreshExpiry(record);
    return cloneSnapshot(record.snapshot);
  }

  answerApproval(
    instanceId: string,
    executionId: string,
    action: SkillAppApprovalAction,
  ): SkillAppInstanceSnapshot {
    const record = this.require(instanceId);
    const execution = this.requireExecution(record, executionId);
    const pending = execution.pendingApproval;
    if (!pending) { throw MarifoldError.approvalNotFound(executionId); }
    execution.pendingApproval = undefined;
    this.setExecutionPhase(record, executionId, 'running');
    pending.settle(action === 'once' ? { approved: true } : { approved: false, reason: 'denied via service' });
    this.refreshExpiry(record);
    return cloneSnapshot(record.snapshot);
  }

  cancelExecution(instanceId: string, executionId: string): SkillAppInstanceSnapshot {
    const record = this.require(instanceId);
    this.abortExecution(record, this.requireExecution(record, executionId));
    this.refreshExpiry(record);
    return cloneSnapshot(record.snapshot);
  }

  delete(instanceId: string): boolean {
    const record = this.instances.get(instanceId);
    if (!record) { return false; }
    for (const [operationName, active] of record.operations) {
      if (active.timer) { clearTimeout(active.timer); }
      active.controller?.abort();
      active.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });
    }
    if (record.execution) { this.abortExecution(record, record.execution); }
    if (record.expiryTimer) { clearTimeout(record.expiryTimer); }
    this.instances.delete(instanceId);
    return true;
  }

  close(): void {
    for (const id of [...this.instances.keys()]) { this.delete(id); }
  }

  /** Validate and store client-editable state; mark dependent outputs stale
   * and cancel their pending automatic work. Returns the changed state names. */
  private applyValues(record: InstanceRecord, values: Record<string, unknown>): string[] {
    const outputStates = new Set(record.definition.operations.map(operation => operation.output));
    const knownStates = new Set(record.definition.states.map(state => state.name));
    for (const [name, rawValue] of Object.entries(values)) {
      if (!knownStates.has(name)) { throw MarifoldError.appInvalid(`SkillApp received unknown state '${name}'.`); }
      if (outputStates.has(name)) { throw MarifoldError.appInvalid(`SkillApp state '${name}' is read-only.`); }
      if (typeof rawValue !== 'string') { throw MarifoldError.appInvalid(`SkillApp state '${name}' must be a string.`); }
      if (record.snapshot.state[name] !== rawValue) { validateSelectValue(record.definition, name, rawValue); }
    }
    const changed: string[] = [];
    for (const [name, rawValue] of Object.entries(values) as Array<[string, string]>) {
      if (record.snapshot.state[name] !== rawValue) { changed.push(name); }
      record.snapshot.state[name] = rawValue;
    }
    for (const operation of record.definition.operations.filter(candidate =>
      operationInputStates(candidate).some(name => changed.includes(name)))) {
      markOutputStale(record.snapshot, operation.output);
      this.cancelOperation(record, operation.name);
    }
    return changed;
  }

  private startExecution(record: InstanceRecord, operation: SkillAppOperationDefinition): void {
    if (operation.interactive && !operation.profile) {
      throw MarifoldError.appInvalid('Interactive SkillApp operations require a registered profile.');
    }
    const id = `app_run_${randomUUID()}`;
    const controller = new AbortController();
    let settleTerminal: (snapshot: SkillAppExecutionSnapshot) => void = () => {};
    const terminal = new Promise<SkillAppExecutionSnapshot>(resolve => { settleTerminal = resolve; });
    record.execution = { id, controller, terminal, settleTerminal };
    record.snapshot.execution = {
      id,
      operation: operation.name,
      phase: 'running',
      startedAt: new Date().toISOString(),
      cancellable: true,
    };
    const input = { ...record.snapshot.state };
    // Only interactive operations receive question/approval handlers; ordinary
    // runs keep their tool set and fail-closed write policy unchanged.
    const interactions: SkillAppInteractionHandlers | undefined = operation.interactive ? {
      approvalHandler: request => this.waitForApproval(record, id, request),
      userInputHandler: request => this.waitForUserInput(record, id, request),
      effectHandler: effect => this.recordEffect(record, id, effect),
    } : undefined;
    void this.runtime.runSkillAppOperation(
      record.definition.app.name,
      operation.name,
      input,
      controller.signal,
      this.historyFor(record, operation),
      this.attachmentsFor(record, operation),
      interactions,
    ).then(result => {
      if (record.execution?.id !== id) { return; }
      if (result.status === 'ok') { this.recordSuccess(record, operation, input, result.data.text); }
      this.finishExecution(record, id, result.status === 'ok' ? 'completed' : 'failed', result);
    }).catch(error => {
      if (record.execution?.id !== id) { return; }
      if (controller.signal.aborted) {
        this.finishExecution(record, id, 'cancelled');
        return;
      }
      this.finishExecution(record, id, 'failed', {
        status: 'error',
        error: {
          code: error instanceof MarifoldError ? error.code : 'APP_INVALID',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }

  private abortExecution(record: InstanceRecord, execution: ActiveExecution): void {
    execution.pendingApproval?.settle({ approved: false, reason: 'execution cancelled' });
    execution.pendingUserInput?.settle(undefined);
    execution.pendingApproval = undefined;
    execution.pendingUserInput = undefined;
    execution.controller.abort();
    this.finishExecution(record, execution.id, 'cancelled');
  }

  private historyFor(
    record: InstanceRecord,
    operation: SkillAppOperationDefinition,
  ): SkillAppHistoryTurn[] | undefined {
    return operation.execution.history && operation.profile
      ? [...(record.historyByProfile.get(operation.profile) ?? [])]
      : undefined;
  }

  private attachmentsFor(
    record: InstanceRecord,
    operation: SkillAppOperationDefinition,
  ): SkillAppAttachmentInput[] | undefined {
    return operation.attachments
      ? [...(record.attachmentsByState.get(operation.attachments) ?? [])]
      : undefined;
  }

  private recordSuccess(
    record: InstanceRecord,
    operation: SkillAppOperationDefinition,
    input: Record<string, SkillAppStateValue>,
    text: string,
  ): void {
    record.snapshot.state[operation.output] = text;
    markOutputFresh(record.snapshot, operation.output);
    if (operation.execution.history && operation.profile) {
      record.historyByProfile.set(operation.profile, appendHistory(
        record.historyByProfile.get(operation.profile) ?? [],
        operationInputText(operation, input),
        text,
      ));
    }
  }

  private waitForApproval(
    record: InstanceRecord,
    executionId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    if (record.execution?.id !== executionId) {
      return Promise.resolve({ approved: false, reason: 'execution no longer active' });
    }
    return new Promise(resolve => {
      record.execution!.pendingApproval = { request, settle: resolve };
      const snapshot = this.requireExecutionSnapshot(record, executionId);
      snapshot.phase = 'waiting_for_approval';
      snapshot.approval = request;
      delete snapshot.userInput;
    });
  }

  private waitForUserInput(
    record: InstanceRecord,
    executionId: string,
    request: UserInputRequest,
  ): Promise<UserInputSubmission | undefined> {
    if (record.execution?.id !== executionId) { return Promise.resolve(undefined); }
    return new Promise(resolve => {
      record.execution!.pendingUserInput = { request, settle: resolve };
      const snapshot = this.requireExecutionSnapshot(record, executionId);
      snapshot.phase = 'waiting_for_input';
      snapshot.userInput = request;
      delete snapshot.approval;
    });
  }

  private setExecutionPhase(
    record: InstanceRecord,
    executionId: string,
    phase: SkillAppExecutionSnapshot['phase'],
  ): void {
    const snapshot = this.requireExecutionSnapshot(record, executionId);
    snapshot.phase = phase;
    delete snapshot.approval;
    delete snapshot.userInput;
  }

  private recordEffect(
    record: InstanceRecord,
    executionId: string,
    effect: SkillAppEffect,
  ): void {
    const snapshot = this.requireExecutionSnapshot(record, executionId);
    snapshot.committedEffects = [...(snapshot.committedEffects ?? []), effect];
    this.refreshExpiry(record);
  }

  private finishExecution(
    record: InstanceRecord,
    executionId: string,
    phase: Extract<SkillAppExecutionSnapshot['phase'], 'completed' | 'failed' | 'cancelled'>,
    result?: SkillAppResult,
  ): void {
    const snapshot = record.snapshot.execution;
    if (!snapshot || snapshot.id !== executionId) { return; }
    if (phase !== 'completed' && snapshot.committedEffects?.length) {
      phase = 'completed';
      const committedResult = committedEffectResult(snapshot);
      result = committedResult;
      const operation = record.definition.operations.find(candidate => candidate.name === snapshot.operation);
      if (operation) {
        record.snapshot.state[operation.output] = committedResult.data.text;
        markOutputFresh(record.snapshot, operation.output);
      }
    }
    snapshot.phase = phase;
    snapshot.finishedAt = new Date().toISOString();
    snapshot.cancellable = false;
    delete snapshot.approval;
    delete snapshot.userInput;
    if (result) { snapshot.result = result; }
    const execution = record.execution;
    record.execution = undefined;
    if (execution?.id === executionId) { execution.settleTerminal(cloneExecution(snapshot)); }
    if (this.instances.has(record.snapshot.id)) { this.refreshExpiry(record); }
    for (const trigger of execution?.id === executionId ? execution.deferredTriggers ?? [] : []) {
      if (!this.instances.has(record.snapshot.id)) { break; }
      if (operationIsRunnable(this.requireOperation(record, trigger.operation).requiredInputs, record.snapshot.state)) {
        void this.schedule(record, trigger).catch(() => undefined);
      }
    }
  }

  private requireExecution(record: InstanceRecord, executionId: string): ActiveExecution {
    const execution = record.execution;
    if (!execution || execution.id !== executionId) {
      throw MarifoldError.appInvalid(`SkillApp execution '${executionId}' is not active.`);
    }
    return execution;
  }

  private requireExecutionSnapshot(
    record: InstanceRecord,
    executionId: string,
  ): SkillAppExecutionSnapshot {
    const execution = record.snapshot.execution;
    if (!execution || execution.id !== executionId) {
      throw MarifoldError.appInvalid(`SkillApp execution '${executionId}' was not found.`);
    }
    return execution;
  }

  private requireOperation(record: InstanceRecord, operationName: string): SkillAppOperationDefinition {
    const operation = record.definition.operations.find(candidate => candidate.name === operationName);
    if (!operation) {
      throw MarifoldError.appInvalid(`SkillApp '${record.definition.app.name}' has no operation '${operationName}'.`);
    }
    return operation;
  }

  private assertIdle(record: InstanceRecord): void {
    if (record.execution) {
      throw MarifoldError.appInvalid(
        `SkillApp operation '${record.snapshot.execution?.operation ?? 'unknown'}' is still active.`,
      );
    }
  }

  private schedule(record: InstanceRecord, trigger: SkillAppTriggerDefinition): Promise<SkillAppMutationResult> {
    if (this.requireOperation(record, trigger.operation).interactive) {
      throw MarifoldError.appInvalid('Interactive SkillApp operations cannot use automatic triggers.');
    }
    return this.executeLatest(record, trigger.operation, trigger.debounce);
  }

  private executeLatest(
    record: InstanceRecord,
    operationName: string,
    delayMs: number,
  ): Promise<SkillAppMutationResult> {
    const previous = record.operations.get(operationName);
    const generation = (previous?.generation ?? 0) + 1;
    if (previous?.timer) { clearTimeout(previous.timer); }
    previous?.controller?.abort();
    previous?.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });

    return new Promise((resolve, reject) => {
      const active: ActiveOperation = { generation, resolve };
      record.operations.set(operationName, active);
      const start = () => {
        active.timer = undefined;
        active.controller = new AbortController();
        const input = { ...record.snapshot.state };
        const operation = this.requireOperation(record, operationName);
        void this.runtime.runSkillAppOperation(
          record.definition.app.name,
          operationName,
          input,
          active.controller.signal,
          this.historyFor(record, operation),
          this.attachmentsFor(record, operation),
        ).then(result => {
          // Identity, not generation: a cancel deletes the entry, so a replacement can reuse the number.
          if (record.operations.get(operationName) !== active) { return; }
          if (result.status === 'ok') { this.recordSuccess(record, operation, input, result.data.text); }
          record.operations.delete(operationName);
          resolve({ status: 'completed', operation: operationName, instance: cloneSnapshot(record.snapshot), result });
        }).catch(error => {
          if (record.operations.get(operationName) !== active) { return; }
          record.operations.delete(operationName);
          if (active.controller?.signal.aborted) {
            resolve({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });
            return;
          }
          reject(error);
        });
      };
      if (delayMs > 0) {
        active.timer = setTimeout(start, delayMs);
        active.timer.unref?.();
      } else {
        start();
      }
    });
  }

  private cancelOperation(record: InstanceRecord, operationName: string): void {
    const active = record.operations.get(operationName);
    if (!active) { return; }
    if (active.timer) { clearTimeout(active.timer); }
    active.controller?.abort();
    record.operations.delete(operationName);
    active.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });
  }

  private require(instanceId: string): InstanceRecord {
    const record = this.instances.get(instanceId);
    if (!record) { throw MarifoldError.appNotFound(instanceId); }
    return record;
  }

  private refreshExpiry(record: InstanceRecord): void {
    if (record.expiryTimer) { clearTimeout(record.expiryTimer); }
    record.expiryTimer = setTimeout(() => this.delete(record.snapshot.id), this.retentionMs);
    record.expiryTimer.unref?.();
  }
}
