import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MarifoldError } from '../errors/MarifoldError';

export type MemoryKind = 'user' | 'preferences' | 'auto_short';
export type MemoryStatus = 'active' | 'superseded';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  source: string;
  created_at: string;
  updated_at: string;
  session_id?: string;
  conflict_key?: string;
  supersedes?: string[];
  [key: string]: unknown;
}

export interface MemoryScaffoldFile {
  path: string;
  status: 'created' | 'kept';
}

export interface MemoryRememberOptions {
  sessionId?: string;
  source?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: string;
  evidence?: string;
  reason?: string;
  expiresAt?: string;
  status?: MemoryStatus;
}

export interface MemoryRememberResult {
  profile: string;
  kind: MemoryKind;
  path: string;
  entry: MemoryEntry;
  created: boolean;
}

export interface MemoryMutationResult {
  profile: string;
  query: string;
  count: number;
  paths: string[];
}

export interface MemorySaveInput {
  kind: MemoryKind;
  text: string;
  source?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: string;
  evidence?: string;
  reason?: string;
  expiresAt?: string;
  status?: MemoryStatus;
}

export interface MemorySaveResult {
  profile: string;
  created: number;
  skipped: number;
  entries: MemoryEntry[];
  paths: string[];
}

export interface MemoryListOptions {
  limit?: number;
  contextLimit?: number;
}

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const CONFLICT_KEY_RE = /^(?:user|preferences|auto_short)(?:\.[a-z0-9][a-z0-9_]{0,39}){1,5}$/;
const DEFAULT_CONTEXT_LIMIT = 2400;

const JSONL_FILES: Record<MemoryKind, string> = {
  user: 'user.jsonl',
  preferences: 'preferences.jsonl',
  auto_short: 'auto_short.jsonl',
};

const KIND_ORDER: MemoryKind[] = ['user', 'preferences', 'auto_short'];

const LEGACY_FILES: Array<{ fileName: string; kind: MemoryKind }> = [
  { fileName: 'user.md', kind: 'user' },
  { fileName: 'preferences.md', kind: 'preferences' },
  { fileName: 'notes.md', kind: 'preferences' },
  { fileName: 'auto_short.md', kind: 'auto_short' },
];

interface JsonLine {
  raw: string;
  entry?: MemoryEntry;
}

export function ensureProfileMemoryFiles(profileDir: string): MemoryScaffoldFile[] {
  const memoriesDir = path.join(profileDir, 'memories');
  fs.mkdirSync(memoriesDir, { recursive: true });
  return KIND_ORDER.map(kind => {
    const filePath = path.join(memoriesDir, JSONL_FILES[kind]);
    if (fs.existsSync(filePath)) return { path: filePath, status: 'kept' };
    fs.writeFileSync(filePath, '');
    return { path: filePath, status: 'created' };
  });
}

export class MemoryStore {
  constructor(private readonly profilesDir: string) {}

  ensureProfile(profile: string): MemoryScaffoldFile[] {
    this.assertSafeProfileName(profile);
    return ensureProfileMemoryFiles(path.join(this.profilesDir, profile));
  }

  remember(
    profile: string,
    kind: MemoryKind,
    text: string,
    options: MemoryRememberOptions = {},
  ): MemoryRememberResult {
    this.assertSafeProfileName(profile);
    const trimmed = text.trim();
    if (!trimmed) throw MarifoldError.memoryInvalid('Memory text cannot be empty.', profile);

    this.ensureProfile(profile);
    const filePath = this.jsonlPath(profile, kind);
    const lines = readJsonlLines(filePath, kind);
    const duplicate = lines
      .map(line => line.entry)
      .find(entry => entry?.status === 'active' && normalize(entry.text) === normalize(trimmed));

    if (duplicate) {
      return { profile, kind, path: filePath, entry: duplicate, created: false };
    }

    const now = utcNow();
    const conflictKey = normalizeConflictKey(options.conflictKey);
    const entry: MemoryEntry = {
      id: randomUUID(),
      kind,
      text: trimmed,
      status: options.status ?? 'active',
      source: options.source ?? 'manual',
      created_at: now,
      updated_at: now,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(conflictKey ? { conflict_key: conflictKey } : {}),
      ...(optionalNumber(options.priority) !== undefined ? { priority: optionalNumber(options.priority) } : {}),
      ...(optionalNumber(options.confidence) !== undefined ? { confidence: optionalNumber(options.confidence) } : {}),
      ...(options.stability ? { stability: options.stability } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
    };

    if (conflictKey) {
      const superseded: string[] = [];
      let changed = false;
      for (const line of lines) {
        if (line.entry?.status === 'active' && conflictKeyForEntry(line.entry) === conflictKey) {
          superseded.push(line.entry.id);
          line.entry = { ...line.entry, status: 'superseded', updated_at: now };
          changed = true;
        }
      }
      if (superseded.length > 0) entry.supersedes = superseded;
      if (changed) writeJsonlLines(filePath, lines);
    }

    appendJsonLine(filePath, entry);
    return { profile, kind, path: filePath, entry, created: true };
  }

  save(profile: string, inputs: MemorySaveInput[], options: Pick<MemoryRememberOptions, 'sessionId'> = {}): MemorySaveResult {
    this.assertSafeProfileName(profile);
    let created = 0;
    let skipped = 0;
    const entries: MemoryEntry[] = [];
    const paths = new Set<string>();

    for (const input of inputs) {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) continue;
      const result = this.remember(profile, input.kind, text, {
        sessionId: options.sessionId,
        source: input.source,
        conflictKey: input.conflictKey,
        priority: input.priority,
        confidence: input.confidence,
        stability: input.stability,
        evidence: input.evidence,
        reason: input.reason,
        expiresAt: input.expiresAt,
        status: input.status,
      });
      if (result.created) created += 1;
      else skipped += 1;
      entries.push(result.entry);
      paths.add(result.path);
    }

    return { profile, created, skipped, entries, paths: [...paths] };
  }

  applySavePayloads(profile: string, payloads: string[], options: Pick<MemoryRememberOptions, 'sessionId'> = {}): MemorySaveResult {
    return this.save(profile, payloads.flatMap(parseSavePayload), options);
  }

  applyForgetPayloads(profile: string, payloads: string[]): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    let count = 0;
    const paths = new Set<string>();
    const queries: string[] = [];

    for (const query of payloads.flatMap(parseForgetPayload)) {
      const result = this.forget(profile, query);
      queries.push(result.query);
      count += result.count;
      for (const filePath of result.paths) paths.add(filePath);
    }

    return { profile, query: queries.join(', '), count, paths: [...paths] };
  }

  forget(profile: string, query: string): MemoryMutationResult {
    return this.updateMatching(profile, query, entry => ({
      ...entry,
      status: 'superseded',
      updated_at: utcNow(),
    }));
  }

  delete(profile: string, query: string): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    const needle = this.normalizeQuery(profile, query);
    this.ensureProfile(profile);
    let count = 0;
    const paths: string[] = [];

    for (const kind of KIND_ORDER) {
      const filePath = this.jsonlPath(profile, kind);
      if (!fs.existsSync(filePath)) continue;

      const lines = readJsonlLines(filePath, kind);
      const next = lines.filter(line => {
        if (line.entry && this.matches(line.entry, needle)) {
          count += 1;
          return false;
        }
        return true;
      });

      if (next.length !== lines.length) {
        writeJsonlLines(filePath, next);
        paths.push(filePath);
      }
    }

    return { profile, query: needle, count, paths };
  }

  listEntries(profile: string): MemoryEntry[] {
    this.assertSafeProfileName(profile);
    this.ensureProfile(profile);
    const entries: MemoryEntry[] = [];
    for (const kind of KIND_ORDER) {
      entries.push(...this.readEntriesFromFile(this.jsonlPath(profile, kind), kind));
    }
    return entries;
  }

  listPromptMemory(profile: string, options: MemoryListOptions = {}): string[] {
    const limit = options.limit ?? 50;
    const contextLimit = options.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const lines = [
      ...this.listEntries(profile)
        .filter(entry => entry.status === 'active')
        .map(formatEntry),
      ...this.readLegacyPromptMemory(profile),
    ].filter(line => line.trim().length > 0);

    return trimPromptMemory(lines, limit, contextLimit);
  }

  private updateMatching(profile: string, query: string, update: (entry: MemoryEntry) => MemoryEntry): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    const needle = this.normalizeQuery(profile, query);
    this.ensureProfile(profile);
    let count = 0;
    const paths: string[] = [];

    for (const kind of KIND_ORDER) {
      const filePath = this.jsonlPath(profile, kind);
      if (!fs.existsSync(filePath)) continue;

      let changed = false;
      const lines = readJsonlLines(filePath, kind).map(line => {
        if (line.entry?.status === 'active' && this.matches(line.entry, needle)) {
          count += 1;
          changed = true;
          return { entry: update(line.entry), raw: line.raw };
        }
        return line;
      });

      if (changed) {
        writeJsonlLines(filePath, lines);
        paths.push(filePath);
      }
    }

    return { profile, query: needle, count, paths };
  }

  private readEntriesFromFile(filePath: string, fallbackKind: MemoryKind): MemoryEntry[] {
    return readJsonlLines(filePath, fallbackKind)
      .map(line => line.entry)
      .filter((entry): entry is MemoryEntry => entry !== undefined);
  }

  private readLegacyPromptMemory(profile: string): string[] {
    const memoriesDir = this.memoriesDir(profile);
    const lines: string[] = [];

    for (const legacy of LEGACY_FILES) {
      const filePath = path.join(memoriesDir, legacy.fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        lines.push(formatMemoryLine(legacy.kind, trimmed));
      }
    }

    return lines;
  }

  private jsonlPath(profile: string, kind: MemoryKind): string {
    return path.join(this.memoriesDir(profile), JSONL_FILES[kind]);
  }

  private memoriesDir(profile: string): string {
    this.assertSafeProfileName(profile);
    return path.join(this.profilesDir, profile, 'memories');
  }

  private normalizeQuery(profile: string, query: string): string {
    const needle = normalize(query);
    if (!needle) throw MarifoldError.memoryInvalid('Memory query cannot be empty.', profile);
    return needle;
  }

  private matches(entry: MemoryEntry, needle: string): boolean {
    return [entry.id, entry.text, entry.conflict_key, conflictKeyForEntry(entry)]
      .filter((value): value is string => typeof value === 'string')
      .some(value => normalize(value).includes(needle));
  }

  private assertSafeProfileName(profile: string): void {
    if (!SAFE_PROFILE_NAME.test(profile)) {
      throw MarifoldError.profileInvalid(
        `Invalid profile name '${profile}'. Use letters, numbers, underscores, or hyphens.`,
        profile,
      );
    }
  }
}

function readJsonlLines(filePath: string, fallbackKind: MemoryKind): JsonLine[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(raw => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const entry = toMemoryEntry(parsed, fallbackKind);
        return entry ? { raw, entry } : { raw };
      } catch {
        return { raw };
      }
    });
}

function toMemoryEntry(value: Record<string, unknown>, fallbackKind: MemoryKind): MemoryEntry | undefined {
  if (typeof value.text !== 'string' || !value.text.trim()) return undefined;

  const kind = normalizeKind(value.kind) ?? fallbackKind;
  const id = typeof value.id === 'string' && value.id ? value.id : randomUUID();
  const createdAt = typeof value.created_at === 'string' ? value.created_at : utcNow();
  const updatedAt = typeof value.updated_at === 'string' ? value.updated_at : createdAt;
  const status = value.status === 'superseded' ? 'superseded' : 'active';

  return {
    ...value,
    id,
    kind,
    text: value.text.trim(),
    status,
    source: typeof value.source === 'string' ? value.source : 'manual',
    created_at: createdAt,
    updated_at: updatedAt,
    ...(typeof value.session_id === 'string' ? { session_id: value.session_id } : {}),
    ...(typeof value.conflict_key === 'string' ? { conflict_key: value.conflict_key } : {}),
  };
}

function normalizeKind(value: unknown): MemoryKind | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'user' || normalized === 'preferences' || normalized === 'auto_short') return normalized;
  if (normalized === 'pref' || normalized === 'prefs' || normalized === 'preference') return 'preferences';
  if (normalized === 'short' || normalized === 'short_term' || normalized === 'session' || normalized === 'auto') return 'auto_short';
  return undefined;
}

function parseSavePayload(payload: string): MemorySaveInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return memoryInputsFromValue(parsed);
}

function memoryInputsFromValue(value: unknown): MemorySaveInput[] {
  if (!isRecord(value)) return [];
  const memories = value.memories;
  if (Array.isArray(memories)) {
    return memories
      .map(item => memoryInputFromRecord(item))
      .filter((input): input is MemorySaveInput => input !== undefined);
  }

  const direct = memoryInputFromRecord(value);
  if (direct) return [direct];

  const legacy: MemorySaveInput[] = [];
  for (const [key, kind] of [
    ['user', 'user'],
    ['preferences', 'preferences'],
    ['pref', 'preferences'],
    ['notes', 'preferences'],
    ['auto_short', 'auto_short'],
    ['short', 'auto_short'],
  ] as Array<[string, MemoryKind]>) {
    const text = typeof value[key] === 'string' ? value[key].trim() : '';
    if (text) legacy.push({ kind, text, source: 'model_inferred' });
  }
  return legacy;
}

function memoryInputFromRecord(value: unknown): MemorySaveInput | undefined {
  if (!isRecord(value)) return undefined;
  const kind = normalizeKind(value.kind ?? value.target);
  const text = stringValue(value.text ?? value.content);
  if (!kind || !text) return undefined;
  return {
    kind,
    text,
    source: stringValue(value.source) || 'model_inferred',
    conflictKey: stringValue(value.conflict_key ?? value.conflicts_with),
    priority: optionalNumber(value.priority),
    confidence: optionalNumber(value.confidence),
    stability: stringValue(value.stability),
    evidence: stringValue(value.evidence),
    reason: stringValue(value.reason),
    expiresAt: stringValue(value.expires_at),
    status: value.status === 'superseded' ? 'superseded' : 'active',
  };
}

function parseForgetPayload(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return forgetQueriesFromValue(parsed);
}

function forgetQueriesFromValue(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!isRecord(value)) return [];

  const rawItems = value.forget ?? value.queries ?? value.items;
  if (Array.isArray(rawItems)) return rawItems.flatMap(forgetQueriesFromValue);

  const query = stringValue(value.query ?? value.conflict_key ?? value.text);
  return query ? [query] : [];
}

function normalizeConflictKey(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const key = raw
    .toLowerCase()
    .replace(/[-:]/g, '.')
    .replace(/\s+/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^user\.preferred_name$/, 'user.name')
    .replace(/^user\.preferred\.name$/, 'user.name')
    .replace(/^user\.fav_/, 'user.favorite_')
    .replace(/favourite/g, 'favorite')
    .replace(/colour/g, 'color')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return CONFLICT_KEY_RE.test(key) ? key : undefined;
}

function conflictKeyForEntry(entry: MemoryEntry): string | undefined {
  return normalizeConflictKey(entry.conflict_key) ?? inferConflictKey(entry.kind, entry.text);
}

function inferConflictKey(kind: MemoryKind, text: string): string | undefined {
  if (kind !== 'user') return undefined;
  const normalized = normalize(text);
  if (
    /\b(?:the\s+)?user(?:'s)?\s+name\s+is\b/.test(normalized)
    || /\buser\s+is\s+named\b/.test(normalized)
    || /^name\s*:/.test(normalized)
  ) {
    return 'user.name';
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendJsonLine(filePath: string, entry: MemoryEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const needsLeadingNewline = fs.existsSync(filePath)
    && fs.statSync(filePath).size > 0
    && !fs.readFileSync(filePath, 'utf-8').endsWith('\n');
  fs.appendFileSync(filePath, `${needsLeadingNewline ? '\n' : ''}${JSON.stringify(entry)}\n`);
}

function writeJsonlLines(filePath: string, lines: JsonLine[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lines
    .map(line => line.entry ? JSON.stringify(line.entry) : line.raw)
    .join('\n');
  fs.writeFileSync(filePath, text ? `${text}\n` : '');
}

function formatEntry(entry: MemoryEntry): string {
  return formatMemoryLine(entry.kind, entry.text);
}

function formatMemoryLine(kind: MemoryKind, text: string): string {
  switch (kind) {
    case 'user':
      return `User: ${text}`;
    case 'preferences':
      return `Preference: ${text}`;
    case 'auto_short':
      return `Short-term: ${text}`;
  }
}

function trimPromptMemory(lines: string[], limit: number, contextLimit: number): string[] {
  const limited = lines.slice(0, Math.max(0, limit));
  if (contextLimit <= 0) return limited;

  const selected: string[] = [];
  let used = 0;
  for (const line of limited) {
    const cost = line.length + (selected.length === 0 ? 0 : 1);
    if (used + cost <= contextLimit) {
      selected.push(line);
      used += cost;
      continue;
    }
    if (selected.length === 0) selected.push(line.slice(0, contextLimit));
    break;
  }
  return selected;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
