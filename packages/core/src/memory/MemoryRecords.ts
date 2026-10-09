import { randomUUID } from 'crypto';
import type { MemoryEntry, MemoryKind, MemorySaveInput, MemoryScope, MemorySourceType, MemoryStability, MemoryStatus } from './MemoryTypes';
import { clampInteger, clampNumber, finiteNumber, isRecord, looksIdentityNameFact, looksResponsePreference, looksTimeSensitive, stringValue, utcNow } from './MemoryText';
import { normalizeConflictKey } from './MemoryConflicts';

// Normalizing stored and model-emitted memory records: kinds, priorities, stability, sources, and save/forget payloads.

export const DEFAULT_PRIORITY = 5;

export function entryFromRecord(
  raw: Record<string, unknown>,
  fallbackKind: MemoryKind,
  defaults: {
    source: string;
    sourceType?: MemorySourceType;
    priority: number;
    confidence: number;
    scope: MemoryScope;
  },
  profile = 'default',
): MemoryEntry | undefined {
  let kind = normalizeKind(raw.kind ?? raw.target) ?? fallbackKind;
  const text = stringValue(raw.text ?? raw.content);
  if (!text) { return undefined; }

  if ((kind === 'user' || kind === 'preferences') && looksTimeSensitive(text)) {
    kind = 'auto_short';
  } else if (kind === 'user' && looksResponsePreference(text)) {
    kind = 'preferences';
  }

  const now = utcNow();
  const priority = normalizePriority(raw.priority, defaultPriority(kind, defaults.priority), kind, text, raw);
  const confidence = clampNumber(raw.confidence, defaults.confidence, 0, 1);
  const stability = normalizeStability(raw.stability, defaultStability(kind));
  const source = normalizeSource(raw.source, defaults.source);
  const sourceType = normalizeSourceType(raw.source_type, defaults.sourceType ?? sourceTypeFromSource(source));
  const scope = normalizeScope(raw.scope, defaults.scope);
  const status: MemoryStatus = raw.status === 'superseded' ? 'superseded' : 'active';
  const rawConflictValue = raw.conflict_key ?? raw.conflicts_with;
  const rawConflictProvided = Boolean(stringValue(rawConflictValue));
  let conflictKey = normalizeConflictKey(rawConflictValue);
  if (conflictKey && !conflictKey.startsWith(`${kind}.`)) { conflictKey = undefined; }
  if (!conflictKey && !rawConflictProvided && kind === 'preferences' && looksResponsePreference(text)) {
    conflictKey = 'preferences.reply_style';
  }
  if (!conflictKey && !rawConflictProvided && kind === 'auto_short' && /\bmeeting\b/i.test(text)) {
    conflictKey = /\bproject meeting\b/i.test(text) ? 'auto_short.project_meeting_time' : 'auto_short.meeting_time';
  }

  const id = stringValue(raw.id) || randomUUID();
  const createdAt = stringValue(raw.created_at) || now;
  const updatedAt = stringValue(raw.updated_at) || now;
  const lastSeenAt = stringValue(raw.last_seen_at) || updatedAt;
  const supersedes = Array.isArray(raw.supersedes)
    ? raw.supersedes.map(item => String(item).trim()).filter(Boolean)
    : [];

  return {
    ...raw,
    id,
    kind,
    text,
    priority,
    confidence,
    stability,
    status,
    source,
    source_type: sourceType,
    scope,
    created_at: createdAt,
    updated_at: updatedAt,
    last_seen_at: lastSeenAt,
    ...(stringValue(raw.session_id) ? { session_id: stringValue(raw.session_id) } : {}),
    ...(stringValue(raw.task_id) ? { task_id: stringValue(raw.task_id) } : {}),
    ...(stringValue(raw.scope_id) ? { scope_id: stringValue(raw.scope_id) } : {}),
    ...(conflictKey ? { conflict_key: conflictKey } : {}),
    ...(supersedes.length > 0 ? { supersedes } : {}),
    ...(stringValue(raw.evidence) ? { evidence: stringValue(raw.evidence) } : {}),
    ...(stringValue(raw.reason) ? { reason: stringValue(raw.reason) } : {}),
    ...(stringValue(raw.expires_at) ? { expires_at: stringValue(raw.expires_at) } : {}),
  };
}

export function normalizePriority(
  value: unknown,
  defaultValue: number,
  kind: MemoryKind,
  text: string,
  raw: Record<string, unknown>,
): number {
  let priority = clampInteger(value, defaultValue, 0, 10);
  const confidence = clampNumber(raw.confidence, 0.6, 0, 1);
  const stability = normalizeStability(raw.stability, defaultStability(kind));
  const conflictKey = normalizeConflictKey(raw.conflict_key ?? raw.conflicts_with);
  const priorityZeroAllowed = (
    kind === 'user'
    && confidence >= 0.9
    && stability === 'stable'
    && (conflictKey === 'user.name' || looksIdentityNameFact(text))
  );
  if (priority === 0 && !priorityZeroAllowed) {
    if (kind === 'preferences') { priority = 2; }
    else if (kind === 'auto_short') { priority = 3; }
    else { priority = 1; }
  }
  return priority;
}

export function parseSavePayload(payload: string): MemorySaveInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return memoryInputsFromValue(parsed);
}

export function memoryInputsFromValue(value: unknown): MemorySaveInput[] {
  if (!isRecord(value)) { return []; }
  const memories = value.memories;
  if (Array.isArray(memories)) {
    return memories
      .map(item => memoryInputFromRecord(item))
      .filter((input): input is MemorySaveInput => input !== undefined);
  }

  const direct = memoryInputFromRecord(value);
  if (direct) { return [direct]; }

  const legacy: MemorySaveInput[] = [];
  for (const [key, kind] of [
    ['user', 'user'],
    ['preferences', 'preferences'],
    ['pref', 'preferences'],
    ['notes', 'preferences'],
    ['auto_short', 'auto_short'],
    ['short', 'auto_short'],
  ] as Array<[string, MemoryKind]>) {
    const text = stringValue(value[key]);
    if (text) { legacy.push({ kind, text, source: 'model_inferred' }); }
  }
  return legacy;
}

export function memoryInputFromRecord(value: unknown): MemorySaveInput | undefined {
  if (!isRecord(value)) { return undefined; }
  const kind = normalizeKind(value.kind ?? value.target);
  const text = stringValue(value.text ?? value.content);
  if (!kind || !text) { return undefined; }
  return {
    kind,
    text,
    source: stringValue(value.source) || 'model_inferred',
    sourceType: value.source_type === undefined ? undefined : normalizeSourceType(value.source_type, undefined),
    scope: normalizeScope(value.scope, 'profile'),
    scopeId: stringValue(value.scope_id),
    conflictKey: stringValue(value.conflict_key ?? value.conflicts_with),
    priority: finiteNumber(value.priority),
    confidence: finiteNumber(value.confidence),
    stability: stringValue(value.stability),
    evidence: stringValue(value.evidence),
    reason: stringValue(value.reason),
    expiresAt: stringValue(value.expires_at),
    status: value.status === 'superseded' ? 'superseded' : 'active',
  };
}

export function parseForgetPayload(payload: string): Array<{ query: string; kind?: MemoryKind }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return forgetQueriesFromValue(parsed);
}

export function forgetQueriesFromValue(value: unknown): Array<{ query: string; kind?: MemoryKind }> {
  if (typeof value === 'string') { return value.trim() ? [{ query: value.trim() }] : []; }
  if (!isRecord(value)) { return []; }

  const rawItems = value.forget ?? value.queries ?? value.items;
  if (Array.isArray(rawItems)) { return rawItems.flatMap(forgetQueriesFromValue); }

  const query = stringValue(value.query ?? value.conflict_key ?? value.text);
  const kind = normalizeKind(value.kind);
  return query ? [{ query, ...(kind ? { kind } : {}) }] : [];
}

export function normalizeKind(value: unknown): MemoryKind | undefined {
  if (typeof value !== 'string') { return undefined; }
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'user' || normalized === 'preferences' || normalized === 'auto_short') { return normalized; }
  if (normalized === 'pref' || normalized === 'prefs' || normalized === 'preference' || normalized === 'notes') { return 'preferences'; }
  if (normalized === 'note' || normalized === 'short' || normalized === 'short_term' || normalized === 'session' || normalized === 'current' || normalized === 'auto') { return 'auto_short'; }
  return undefined;
}

export function normalizeStability(value: unknown, fallback: MemoryStability): MemoryStability {
  return isStability(value) ? value : fallback;
}

export function isStability(value: unknown): value is MemoryStability {
  return value === 'stable' || value === 'evolving' || value === 'session' || value === 'ephemeral';
}

export function normalizeSource(value: unknown, fallback: string): string {
  const source = stringValue(value);
  return /^[a-z][a-z0-9_:-]{0,60}$/.test(source) ? source : fallback;
}

export function normalizeSourceType(value: unknown, fallback?: MemorySourceType): MemorySourceType {
  if (
    value === 'user'
    || value === 'model'
    || value === 'system'
    || value === 'tool'
    || value === 'file'
    || value === 'browser'
    || value === 'external_agent'
  ) {
    return value;
  }
  return fallback ?? 'model';
}

export function normalizeScope(value: unknown, fallback: MemoryScope): MemoryScope {
  if (
    value === 'profile'
    || value === 'workspace'
    || value === 'project'
    || value === 'session'
    || value === 'task'
    || value === 'global'
  ) {
    return value;
  }
  return fallback;
}

export function sourceTypeFromSource(source: string): MemorySourceType {
  if (source === 'user_direct' || source === 'manual') { return 'user'; }
  if (source === 'system') { return 'system'; }
  if (source.startsWith('tool')) { return 'tool'; }
  if (source.startsWith('file')) { return 'file'; }
  if (source.startsWith('browser')) { return 'browser'; }
  if (source.startsWith('external_agent')) { return 'external_agent'; }
  return 'model';
}

export function defaultStability(kind: MemoryKind): MemoryStability {
  return kind === 'auto_short' ? 'session' : 'evolving';
}

export function defaultPriority(kind: MemoryKind, explicitDefault: number): number {
  return explicitDefault >= 0 && explicitDefault <= 10 ? explicitDefault : kind === 'auto_short' ? 5 : DEFAULT_PRIORITY;
}

export function manualPriority(kind: MemoryKind): number {
  if (kind === 'user') { return 1; }
  if (kind === 'preferences') { return 2; }
  return 3;
}

export function manualStability(kind: MemoryKind): MemoryStability {
  return kind === 'auto_short' ? 'session' : 'stable';
}

export function manualReason(kind: MemoryKind): string {
  if (kind === 'user') { return 'Manual durable user memory command.'; }
  if (kind === 'preferences') { return 'Manual durable preference memory command.'; }
  return 'Manual short-term memory command.';
}
