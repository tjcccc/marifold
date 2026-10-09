import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { createSkillAppInstance, getSkillAppInstance } from '../../api/apps';
import type { AgentUsage, SkillAppAttachmentInput, SkillAppDefinition, SkillAppExecutionSnapshot, SkillAppInstanceSnapshot } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { fileToBase64 } from '../../lib/attachments';

// SkillApp instance storage and opening, execution and input state, and activity formatting for the Apps screen.

export interface RunMetrics {
  latencyMs?: number;
  usage?: AgentUsage;
}

export function initialValues(app: SkillAppDefinition): Record<string, string> {
  return Object.fromEntries(app.states.map(state => [state.name, state.initial]));
}

export async function attachmentInputs(attachments: PreparedAttachment[]): Promise<SkillAppAttachmentInput[]> {
  return Promise.all(attachments.map(async attachment => {
    if (attachment.kind === 'image') {
      return {
        kind: 'image' as const,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        data: attachment.data,
      };
    }
    if (attachment.kind === 'file') {
      return {
        kind: 'file' as const,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        data: await fileToBase64(attachment.originalFile),
      };
    }
    const source = attachment.originalFile
      ?? new Blob([attachment.content], { type: attachment.mediaType || 'text/plain' });
    return {
      kind: 'file' as const,
      name: attachment.name,
      mediaType: attachment.mediaType || source.type || 'text/plain',
      size: source.size,
      data: await fileToBase64(source),
      inspectionText: attachment.content,
    };
  }));
}

export function isOperationRunnable(requiredInputs: string[], values: Record<string, string>): boolean {
  return requiredInputs.every(name => (values[name] ?? '').trim().length > 0);
}

export function isExecutionActive(execution: SkillAppExecutionSnapshot | undefined): boolean {
  return execution?.phase === 'running'
    || execution?.phase === 'waiting_for_input'
    || execution?.phase === 'waiting_for_approval';
}

export async function openSkillAppInstance(
  client: ApiClient,
  appName: string,
  storageKey: string,
): Promise<SkillAppInstanceSnapshot> {
  const storedId = readStoredInstance(storageKey);
  if (storedId) {
    try {
      const snapshot = await getSkillAppInstance(client, storedId);
      if (snapshot.appName === appName) { return snapshot; }
    } catch (error) {
      if (!(error instanceof MarifoldApiError) || error.code !== 'APP_NOT_FOUND') { throw error; }
    }
    removeStoredInstance(storageKey);
  }
  return createSkillAppInstance(client, appName);
}

export function skillAppInstanceStorageKey(client: ApiClient, appName: string): string {
  return `marifold.skillapp.instance:${encodeURIComponent(client.baseUrl || 'same-origin')}:${appName}`;
}

export function readStoredInstance(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeInstance(key: string, instanceId: string): void {
  try {
    window.sessionStorage.setItem(key, instanceId);
  } catch {
    // Resuming is a convenience; the service-owned run remains authoritative.
  }
}

export function removeStoredInstance(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore unavailable browser storage.
  }
}

export function executionStatus(execution: SkillAppExecutionSnapshot): string {
  switch (execution.phase) {
    case 'waiting_for_input':
      return 'Waiting for your answers';
    case 'waiting_for_approval':
      return 'Waiting for your approval';
    default:
      return `Running ${humanize(execution.operation)}…`;
  }
}

export function operationInputStates(operation: SkillAppDefinition['operations'][number]): string[] {
  return [...new Set([
    ...(operation.skillState ? [operation.skillState] : []),
    ...(operation.input ? [operation.input] : []),
    ...operation.requiredInputs,
    ...Object.values(operation.parameters),
  ])];
}

export function humanize(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : 'Operation';
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function formatActivityTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatMetrics(metrics: RunMetrics): string {
  const parts: string[] = [];
  if (metrics.latencyMs !== undefined) { parts.push(`${formatSeconds(metrics.latencyMs)}s`); }
  if (metrics.usage?.totalTokens !== undefined) { parts.push(`${formatTokens(metrics.usage.totalTokens)} tokens`); }
  return parts.join(' · ');
}

export function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '');
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(tokens);
}
