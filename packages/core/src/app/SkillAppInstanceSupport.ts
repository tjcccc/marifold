import * as path from 'path';
import { MAX_RUN_INPUT_BYTES, MAX_RUN_INSPECTION_TEXT_BYTES } from '../agent/RunWorkspace';
import { MarifoldError } from '../errors/MarifoldError';
import { MAX_IMAGES_PER_REQUEST } from '../images/ImageOptimizer';
import type {
  SkillAppAttachmentInput,
  SkillAppDefinition,
  SkillAppExecutionSnapshot,
  SkillAppHistoryTurn,
  SkillAppInstanceSnapshot,
  SkillAppResult,
  SkillAppStateValue,
} from './SkillAppSchema';

// Pure snapshot, history, and input-validation helpers for SkillAppInstanceRegistry.

type SkillAppOperation = SkillAppDefinition['operations'][number];

export function operationInputText(
  operation: SkillAppOperation,
  state: Record<string, SkillAppStateValue>,
): string {
  if (operation.input) { return state[operation.input] ?? ''; }
  const values = Object.values(operation.parameters)
    .map(name => state[name] ?? '')
    .filter(value => value.trim().length > 0);
  return values.join('\n');
}

export function appendHistory(
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

export function validateSelectValue(definition: SkillAppDefinition, stateName: string, value: string): void {
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

export function cloneSnapshot(snapshot: SkillAppInstanceSnapshot): SkillAppInstanceSnapshot {
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
    ...(snapshot.execution ? { execution: cloneExecution(snapshot.execution) } : {}),
  };
}

export function cloneExecution(execution: SkillAppExecutionSnapshot): SkillAppExecutionSnapshot {
  return {
    ...execution,
    ...(execution.userInput ? {
      userInput: {
        ...execution.userInput,
        questions: execution.userInput.questions.map(question => ({
          ...question,
          options: question.options.map(option => ({ ...option })),
        })),
      },
    } : {}),
    ...(execution.approval ? {
      approval: {
        ...execution.approval,
        input: { ...execution.approval.input },
      },
    } : {}),
    ...(execution.committedEffects ? {
      committedEffects: execution.committedEffects.map(effect => ({
        ...effect,
        files: [...effect.files],
      })),
    } : {}),
    ...(execution.result ? { result: cloneResult(execution.result) } : {}),
  };
}

export function cloneResult(result: SkillAppResult): SkillAppResult {
  if (result.status === 'error') {
    return { ...result, error: { ...result.error } };
  }
  return {
    ...result,
    data: { ...result.data },
    meta: {
      ...result.meta,
      ...(result.meta.usage ? { usage: { ...result.meta.usage } } : {}),
    },
    ...(result.effects
      ? { effects: result.effects.map(effect => ({ ...effect, files: [...effect.files] })) }
      : {}),
  };
}

export function committedEffectResult(snapshot: SkillAppExecutionSnapshot): SkillAppResult & { status: 'ok' } {
  const effects = snapshot.committedEffects ?? [];
  const text = effects.map(effect =>
    `${effect.action === 'created' ? 'Created' : 'Updated'} SkillApp '${effect.title}' (${effect.appName}).`)
    .join('\n');
  return {
    status: 'ok',
    data: { text: `${text}\nThe service does not need a restart.` },
    meta: {
      engine: 'marifold',
      model: 'skillapp-builder',
      durationMs: Math.max(0, Date.now() - Date.parse(snapshot.startedAt)),
    },
    effects: effects.map(effect => ({ ...effect, files: [...effect.files] })),
  };
}

export function operationInputStates(operation: SkillAppOperation): string[] {
  return [...new Set([
    ...(operation.skillState ? [operation.skillState] : []),
    ...(operation.input ? [operation.input] : []),
    ...operation.requiredInputs,
    ...Object.values(operation.parameters),
  ])];
}

export function markOutputStale(snapshot: SkillAppInstanceSnapshot, output: string): void {
  if (!(snapshot.state[output] ?? '').trim()) { return; }
  snapshot.staleOutputs = [...new Set([...(snapshot.staleOutputs ?? []), output])];
}

export function markOutputFresh(snapshot: SkillAppInstanceSnapshot, output: string): void {
  const remaining = (snapshot.staleOutputs ?? []).filter(candidate => candidate !== output);
  if (remaining.length > 0) { snapshot.staleOutputs = remaining; }
  else { delete snapshot.staleOutputs; }
}

export function clearOutput(snapshot: SkillAppInstanceSnapshot, output: string): void {
  snapshot.state[output] = '';
  markOutputFresh(snapshot, output);
}

export function validateAttachments(inputs: SkillAppAttachmentInput[]): SkillAppAttachmentInput[] {
  if (!Array.isArray(inputs)) { throw MarifoldError.appInvalid('SkillApp attachments must be an array.'); }
  if (inputs.length > 16) { throw MarifoldError.appInvalid('SkillApp attachments are limited to 16 files.'); }
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

export function operationIsRunnable(
  requiredInputs: string[],
  state: Record<string, SkillAppStateValue>,
): boolean {
  return requiredInputs.every(name => (state[name] ?? '').trim().length > 0);
}
