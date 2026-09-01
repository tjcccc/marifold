import { randomUUID } from 'crypto';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { MAX_RUN_INPUT_BYTES, MAX_RUN_INSPECTION_TEXT_BYTES } from '../agent/RunWorkspace';
import { MAX_IMAGES_PER_REQUEST } from '../images/ImageOptimizer';
import type {
  SkillAppAttachmentInput,
  SkillAppDefinition,
  SkillAppHistoryTurn,
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
    history?: SkillAppHistoryTurn[],
    attachments?: SkillAppAttachmentInput[],
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
  historyByProfile: Map<string, SkillAppHistoryTurn[]>;
  attachmentsByState: Map<string, SkillAppAttachmentInput[]>;
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
    const affectedOperations = record.definition.operations.filter(operation =>
      operationInputStates(operation).some(name => changed.includes(name)));
    const missingOperations = affectedOperations.filter(operation =>
      !operationIsRunnable(operation.requiredInputs, record.snapshot.state));
    for (const operation of affectedOperations) {
      markOutputStale(record.snapshot, operation.output);
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
      markOutputStale(record.snapshot, operation.output);
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

  updateAttachments(
    instanceId: string,
    stateName: string,
    attachments: SkillAppAttachmentInput[],
  ): SkillAppMutationResult {
    const record = this.require(instanceId);
    this.refreshExpiry(record);
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
        const operation = record.definition.operations.find(candidate => candidate.name === operationName)!;
        const historyKey = operation.profile;
        const history = operation.execution.history && historyKey
          ? [...(record.historyByProfile.get(historyKey) ?? [])]
          : undefined;
        const attachments = operation.attachments
          ? [...(record.attachmentsByState.get(operation.attachments) ?? [])]
          : undefined;
        void this.runtime.runSkillAppOperation(
          record.definition.app.name,
          operationName,
          input,
          active.controller.signal,
          history,
          attachments,
        ).then(result => {
          if (record.operations.get(operationName)?.generation !== generation) return;
          if (result.status === 'ok') {
            record.snapshot.state[operation.output] = result.data.text;
            markOutputFresh(record.snapshot, operation.output);
            if (operation.execution.history && historyKey) {
              record.historyByProfile.set(historyKey, appendHistory(
                record.historyByProfile.get(historyKey) ?? [],
                operationInputText(operation, input),
                result.data.text,
              ));
            }
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

function operationInputText(
  operation: SkillAppDefinition['operations'][number],
  state: Record<string, SkillAppStateValue>,
): string {
  if (operation.input) return state[operation.input] ?? '';
  const values = Object.values(operation.parameters)
    .map(name => state[name] ?? '')
    .filter(value => value.trim().length > 0);
  return values.join('\n');
}

function appendHistory(
  history: SkillAppHistoryTurn[],
  user: string,
  assistant: string,
): SkillAppHistoryTurn[] {
  const next: SkillAppHistoryTurn[] = [
    ...history,
    { role: 'user' as const, content: user },
    { role: 'assistant' as const, content: assistant },
  ].slice(-20);
  let chars = next.reduce((sum, turn) => sum + turn.content.length, 0);
  while (next.length > 2 && chars > 16_000) {
    const removed = next.shift();
    chars -= removed?.content.length ?? 0;
  }
  return next;
}

function validateSelectValue(definition: SkillAppDefinition, stateName: string, value: string): void {
  const selects = flatten(definition.layout).filter(item => item.component === 'select' && item.bind === stateName);
  for (const select of selects) {
    const allowed = (select.options ?? []).map(option => typeof option === 'string' ? option : option.value);
    if (!allowed.includes(value)) {
      throw MarifoldError.appInvalid(`SkillApp state '${stateName}' must be one of: ${allowed.join(', ')}.`);
    }
  }
}

function flatten(items: SkillAppDefinition['layout']): SkillAppDefinition['layout'] {
  return items.flatMap(item => [item, ...flatten(item.children ?? [])]);
}

function cloneSnapshot(snapshot: SkillAppInstanceSnapshot): SkillAppInstanceSnapshot {
  return {
    ...snapshot,
    state: { ...snapshot.state },
    ...(snapshot.staleOutputs ? { staleOutputs: [...snapshot.staleOutputs] } : {}),
    ...(snapshot.attachments ? {
      attachments: Object.fromEntries(Object.entries(snapshot.attachments).map(([name, attachments]) => [
        name,
        attachments.map(attachment => ({ ...attachment })),
      ])),
    } : {}),
  };
}

function operationInputStates(
  operation: SkillAppDefinition['operations'][number],
): string[] {
  return [...new Set([
    ...(operation.skillState ? [operation.skillState] : []),
    ...(operation.input ? [operation.input] : []),
    ...operation.requiredInputs,
    ...Object.values(operation.parameters),
  ])];
}

function markOutputStale(snapshot: SkillAppInstanceSnapshot, output: string): void {
  if (!(snapshot.state[output] ?? '').trim()) return;
  snapshot.staleOutputs = [...new Set([...(snapshot.staleOutputs ?? []), output])];
}

function markOutputFresh(snapshot: SkillAppInstanceSnapshot, output: string): void {
  const remaining = (snapshot.staleOutputs ?? []).filter(candidate => candidate !== output);
  if (remaining.length > 0) snapshot.staleOutputs = remaining;
  else delete snapshot.staleOutputs;
}

function validateAttachments(inputs: SkillAppAttachmentInput[]): SkillAppAttachmentInput[] {
  if (!Array.isArray(inputs)) throw MarifoldError.appInvalid('SkillApp attachments must be an array.');
  if (inputs.length > 16) throw MarifoldError.appInvalid('SkillApp attachments are limited to 16 files.');
  let total = 0;
  let images = 0;
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object') {
      throw MarifoldError.appInvalid(`SkillApp attachment #${index + 1} must be an object.`);
    }
    const name = path.basename(input.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!name || name === '.' || name === '..') {
      throw MarifoldError.appInvalid(`SkillApp attachment #${index + 1} needs a valid filename.`);
    }
    if (input.kind !== 'image' && input.kind !== 'file') {
      throw MarifoldError.appInvalid(`SkillApp attachment '${name}' has an invalid kind.`);
    }
    if (!input.mediaType || typeof input.mediaType !== 'string') {
      throw MarifoldError.appInvalid(`SkillApp attachment '${name}' needs a media type.`);
    }
    if (input.kind === 'image') {
      images += 1;
      if (images > MAX_IMAGES_PER_REQUEST) {
        throw MarifoldError.appInvalid(`SkillApp attachments are limited to ${MAX_IMAGES_PER_REQUEST} images.`);
      }
      if (!input.mediaType.startsWith('image/')) {
        throw MarifoldError.appInvalid(`SkillApp image '${name}' needs an image media type.`);
      }
    }
    if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 === 1) {
      throw MarifoldError.appInvalid(`SkillApp attachment '${name}' must contain base64 data.`);
    }
    const size = Buffer.from(input.data, 'base64').length;
    if (size === 0 || size !== input.size) {
      throw MarifoldError.appInvalid(`SkillApp attachment '${name}' has invalid size metadata.`);
    }
    total += size;
    if (total > MAX_RUN_INPUT_BYTES) {
      throw MarifoldError.appInvalid(`SkillApp attachments exceed ${MAX_RUN_INPUT_BYTES / (1024 * 1024)} MiB.`);
    }
    if (input.inspectionText !== undefined
      && (typeof input.inspectionText !== 'string'
        || Buffer.byteLength(input.inspectionText, 'utf8') > MAX_RUN_INSPECTION_TEXT_BYTES)) {
      throw MarifoldError.appInvalid(
        `SkillApp attachment '${name}' inspection text exceeds ${MAX_RUN_INSPECTION_TEXT_BYTES / 1024} KiB.`,
      );
    }
    return {
      kind: input.kind,
      name,
      mediaType: input.mediaType,
      size,
      data: input.data,
      ...(input.inspectionText !== undefined ? { inspectionText: input.inspectionText } : {}),
    };
  });
}

function operationIsRunnable(
  requiredInputs: string[],
  state: Record<string, SkillAppStateValue>,
): boolean {
  return requiredInputs.every(name => (state[name] ?? '').trim().length > 0);
}
