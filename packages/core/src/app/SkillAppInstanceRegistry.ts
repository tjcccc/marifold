import { randomUUID } from 'crypto';
import { MarifoldError } from '../errors/MarifoldError';
import type {
  SkillAppDefinition,
  SkillAppInstanceSnapshot,
  SkillAppMutationResult,
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
  ): Promise<SkillAppResult>;
}

interface ActiveOperation {
  generation: number;
  controller?: AbortController;
  timer?: NodeJS.Timeout;
  resolve?: (result: SkillAppMutationResult) => void;
}

interface InstanceRecord {
  definition: SkillAppDefinition;
  snapshot: SkillAppInstanceSnapshot;
  operations: Map<string, ActiveOperation>;
  expiryTimer?: NodeJS.Timeout;
}

/** Ephemeral service-owned state for declarative SkillApp bindings/triggers. */
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
    if (!definition) throw MarifoldError.appNotFound(appName);
    const id = `app_${randomUUID()}`;
    const snapshot: SkillAppInstanceSnapshot = {
      id,
      appName,
      state: Object.fromEntries(definition.states.map(item => [item.name, item.initial])),
    };
    const record: InstanceRecord = { definition, snapshot, operations: new Map() };
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
    const outputStates = new Set(record.definition.operations.map(operation => operation.output));
    const knownStates = new Set(record.definition.states.map(state => state.name));
    const changed: string[] = [];
    for (const [name, rawValue] of Object.entries(values)) {
      if (!knownStates.has(name)) throw MarifoldError.appInvalid(`SkillApp received unknown state '${name}'.`);
      if (outputStates.has(name)) throw MarifoldError.appInvalid(`SkillApp state '${name}' is read-only.`);
      if (typeof rawValue !== 'string') throw MarifoldError.appInvalid(`SkillApp state '${name}' must be a string.`);
      validateSelectValue(record.definition, name, rawValue);
    }
    for (const [name, rawValue] of Object.entries(values) as Array<[string, string]>) {
      if (record.snapshot.state[name] !== rawValue) changed.push(name);
      record.snapshot.state[name] = rawValue;
    }
    if (changed.length === 0) return { status: 'idle', instance: cloneSnapshot(record.snapshot) };
    const triggers = record.definition.triggers.filter(trigger =>
      trigger.onChange.some(name => changed.includes(name)));
    const missingOperations = record.definition.operations.filter(operation =>
      operation.requiredInputs.some(name => changed.includes(name))
      && !operationIsRunnable(operation.requiredInputs, record.snapshot.state));
    for (const operation of missingOperations) {
      record.snapshot.state[operation.output] = '';
      this.cancelOperation(record, operation.name);
    }
    const runnableTriggers = triggers.filter(trigger => {
      const operation = record.definition.operations.find(candidate => candidate.name === trigger.operation)!;
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

  run(instanceId: string, operationName: string): Promise<SkillAppMutationResult> {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
    const operation = record.definition.operations.find(candidate => candidate.name === operationName);
    if (!operation) {
      throw MarifoldError.appInvalid(`SkillApp '${record.definition.app.name}' has no operation '${operationName}'.`);
    }
    if (!operationIsRunnable(operation.requiredInputs, record.snapshot.state)) {
      record.snapshot.state[operation.output] = '';
      this.cancelOperation(record, operationName);
      return Promise.resolve({
        status: 'idle',
        reason: 'missing_required_input',
        operation: operationName,
        instance: cloneSnapshot(record.snapshot),
      });
    }
    return this.executeLatest(record, operationName, 0);
  }

  delete(instanceId: string): boolean {
    const record = this.instances.get(instanceId);
    if (!record) return false;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    for (const [operationName, active] of record.operations) {
      if (active.timer) clearTimeout(active.timer);
      active.controller?.abort();
      active.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });
    }
    this.instances.delete(instanceId);
    return true;
  }

  close(): void {
    for (const id of [...this.instances.keys()]) this.delete(id);
  }

  private schedule(record: InstanceRecord, trigger: SkillAppTriggerDefinition): Promise<SkillAppMutationResult> {
    return this.executeLatest(record, trigger.operation, trigger.debounce);
  }

  private executeLatest(
    record: InstanceRecord,
    operationName: string,
    delayMs: number,
  ): Promise<SkillAppMutationResult> {
    const previous = record.operations.get(operationName);
    const generation = (previous?.generation ?? 0) + 1;
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.controller?.abort();
    previous?.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });

    return new Promise((resolve, reject) => {
      const active: ActiveOperation = { generation, resolve };
      record.operations.set(operationName, active);
      const start = () => {
        active.timer = undefined;
        active.controller = new AbortController();
        const input = { ...record.snapshot.state };
        void this.runtime.runSkillAppOperation(
          record.definition.app.name,
          operationName,
          input,
          active.controller.signal,
        ).then(result => {
          if (record.operations.get(operationName)?.generation !== generation) return;
          if (result.status === 'ok') {
            const operation = record.definition.operations.find(candidate => candidate.name === operationName)!;
            record.snapshot.state[operation.output] = result.data.text;
          }
          record.operations.delete(operationName);
          resolve({ status: 'completed', operation: operationName, instance: cloneSnapshot(record.snapshot), result });
        }).catch(error => {
          if (record.operations.get(operationName)?.generation !== generation) return;
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
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.controller?.abort();
    record.operations.delete(operationName);
    active.resolve?.({ status: 'superseded', operation: operationName, instance: cloneSnapshot(record.snapshot) });
  }

  private require(instanceId: string): InstanceRecord {
    const record = this.instances.get(instanceId);
    if (!record) throw MarifoldError.appNotFound(instanceId);
    return record;
  }

  private refreshExpiry(record: InstanceRecord): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = setTimeout(() => this.delete(record.snapshot.id), this.retentionMs);
    record.expiryTimer.unref?.();
  }
}

function validateSelectValue(definition: SkillAppDefinition, stateName: string, value: string): void {
  const selects = flatten(definition.layout).filter(item => item.component === 'select' && item.bind === stateName);
  for (const select of selects) {
    if (!(select.options ?? []).includes(value)) {
      throw MarifoldError.appInvalid(`SkillApp state '${stateName}' must be one of: ${(select.options ?? []).join(', ')}.`);
    }
  }
}

function flatten(items: SkillAppDefinition['layout']): SkillAppDefinition['layout'] {
  return items.flatMap(item => [item, ...flatten(item.children ?? [])]);
}

function cloneSnapshot(snapshot: SkillAppInstanceSnapshot): SkillAppInstanceSnapshot {
  return { ...snapshot, state: { ...snapshot.state } };
}

function operationIsRunnable(
  requiredInputs: string[],
  state: Record<string, SkillAppStateValue>,
): boolean {
  return requiredInputs.every(name => (state[name] ?? '').trim().length > 0);
}
