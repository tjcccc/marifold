import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MarifoldError } from '../errors/MarifoldError';

export type MemoryKind = 'user' | 'preferences' | 'auto_short';
export type MemoryStatus = 'active' | 'superseded';
export type MemoryScope = 'profile' | 'workspace' | 'project' | 'session' | 'task' | 'global';
export type MemorySourceType = 'user' | 'model' | 'system' | 'tool' | 'file' | 'browser' | 'external_agent';
export type MemoryStability = 'stable' | 'evolving' | 'session' | 'ephemeral';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  priority: number;
  confidence: number;
  stability: MemoryStability;
  status: MemoryStatus;
  source: string;
  source_type: MemorySourceType;
  scope: MemoryScope;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  session_id?: string;
  task_id?: string;
  scope_id?: string;
  conflict_key?: string;
  supersedes?: string[];
  evidence?: string;
  reason?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface MemoryScaffoldFile {
  path: string;
  status: 'created' | 'kept';
}

export interface MemoryRememberOptions {
  sessionId?: string;
  taskId?: string;
  source?: string;
  sourceType?: MemorySourceType;
  scope?: MemoryScope;
  scopeId?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: MemoryStability | string;
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
  sourceType?: MemorySourceType;
  scope?: MemoryScope;
  scopeId?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: MemoryStability | string;
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
  thinking?: boolean;
  prompt?: string;
}

interface JsonLine {
  raw: string;
  entry?: MemoryEntry;
}

interface SaveEntryResult {
  created: boolean;
  entry: MemoryEntry;
  path: string;
}

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const CONFLICT_KEY_RE = /^(?:user|preferences|auto_short)(?:\.[a-z0-9][a-z0-9_]{0,39}){1,5}$/;
const DEFAULT_CONTEXT_LIMIT = 2400;
const DEFAULT_PRIORITY = 5;
const NORMAL_PRIORITY_CUTOFF = 3;
const THINKING_PRIORITY_CUTOFF = 10;
const SIMPLE_PROMPT_PRIORITY_CUTOFF = 0;

const JSONL_FILES: Record<MemoryKind, string> = {
  user: 'user.jsonl',
  preferences: 'preferences.jsonl',
  auto_short: 'auto_short.jsonl',
};

const KIND_ORDER: MemoryKind[] = ['user', 'preferences', 'auto_short'];

const LEGACY_FILES: Array<{ fileName: string; kind: MemoryKind; priority: number; reason: string }> = [
  { fileName: 'user.md', kind: 'user', priority: 3, reason: 'Legacy user.md fallback' },
  { fileName: 'preferences.md', kind: 'preferences', priority: 3, reason: 'Legacy preferences.md fallback' },
  { fileName: 'notes.md', kind: 'preferences', priority: 3, reason: 'Legacy notes.md fallback' },
  { fileName: 'auto_short.md', kind: 'auto_short', priority: 8, reason: 'Legacy auto_short.md fallback' },
];

const CONFLICT_KEY_ALIASES: Record<string, string> = {
  'user.fav_color': 'user.favorite_color',
  'user.favorite_colour': 'user.favorite_color',
  'user.preferred_color': 'user.favorite_color',
  'user.preferred_colour': 'user.favorite_color',
  'user.color': 'user.favorite_color',
  'user.colour': 'user.favorite_color',
  'user.color_preference': 'user.favorite_color',
  'user.colour_preference': 'user.favorite_color',
  'user.preferred_name': 'user.name',
  'user.preferred.name': 'user.name',
  'preferences.answer_style': 'preferences.reply_style',
  'preferences.answers_style': 'preferences.reply_style',
  'preferences.response_style': 'preferences.reply_style',
  'preferences.responses_style': 'preferences.reply_style',
  'preferences.communication_style': 'preferences.reply_style',
  'preferences.conversation_style': 'preferences.reply_style',
  'preferences.tone_style': 'preferences.reply_style',
  'preferences.reply_length': 'preferences.reply_style',
  'preferences.response_length': 'preferences.reply_style',
  'preferences.preferred_language': 'preferences.language',
  'preferences.language_preference': 'preferences.language',
  'auto_short.project_meeting': 'auto_short.project_meeting_time',
  'auto_short.meeting': 'auto_short.meeting_time',
};

const GENERIC_CONFLICT_KEYS = new Set([
  'user.info',
  'user.fact',
  'user.memory',
  'preferences.info',
  'preferences.fact',
  'preferences.memory',
  'auto_short.info',
  'auto_short.fact',
  'auto_short.memory',
]);

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

    const result = this.saveEntry(profile, entryFromRecord({
      kind,
      text: trimmed,
      source: options.source ?? 'user_direct',
      source_type: options.sourceType ?? 'user',
      scope: options.scope ?? 'profile',
      scope_id: options.scopeId,
      session_id: options.sessionId,
      task_id: options.taskId,
      conflict_key: options.conflictKey,
      priority: options.priority ?? manualPriority(kind),
      confidence: options.confidence ?? 1,
      stability: options.stability ?? manualStability(kind),
      evidence: options.evidence,
      reason: options.reason ?? manualReason(kind),
      expires_at: options.expiresAt,
      status: options.status,
    }, kind, {
      source: options.source ?? 'user_direct',
      sourceType: options.sourceType ?? 'user',
      priority: options.priority ?? manualPriority(kind),
      confidence: options.confidence ?? 1,
      scope: options.scope ?? 'profile',
    }, profile));

    return {
      profile,
      kind: result.entry.kind,
      path: result.path,
      entry: result.entry,
      created: result.created,
    };
  }

  save(profile: string, inputs: MemorySaveInput[], options: Pick<MemoryRememberOptions, 'sessionId' | 'taskId'> = {}): MemorySaveResult {
    this.assertSafeProfileName(profile);
    let created = 0;
    let skipped = 0;
    const entries: MemoryEntry[] = [];
    const paths = new Set<string>();

    for (const input of inputs) {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) continue;
      const entry = entryFromRecord({
        kind: input.kind,
        text,
        source: input.source,
        source_type: input.sourceType,
        scope: input.scope,
        scope_id: input.scopeId,
        session_id: options.sessionId,
        task_id: options.taskId,
        conflict_key: input.conflictKey,
        priority: input.priority,
        confidence: input.confidence,
        stability: input.stability,
        evidence: input.evidence,
        reason: input.reason,
        expires_at: input.expiresAt,
        status: input.status,
      }, input.kind, {
        source: input.source ?? 'model_inferred',
        sourceType: input.sourceType,
        priority: DEFAULT_PRIORITY,
        confidence: 0.6,
        scope: input.scope ?? 'profile',
      }, profile);
      if (!entry) continue;
      const result = this.saveEntry(profile, entry);
      if (result.created) created += 1;
      else skipped += 1;
      entries.push(result.entry);
      paths.add(result.path);
    }

    return { profile, created, skipped, entries, paths: [...paths] };
  }

  applySavePayloads(profile: string, payloads: string[], options: Pick<MemoryRememberOptions, 'sessionId' | 'taskId'> = {}): MemorySaveResult {
    return this.save(profile, payloads.flatMap(parseSavePayload), options);
  }

  applyForgetPayloads(profile: string, payloads: string[]): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    let count = 0;
    const paths = new Set<string>();
    const queries: string[] = [];

    for (const query of payloads.flatMap(parseForgetPayload)) {
      const result = this.forget(profile, query.query, query.kind);
      queries.push(result.query);
      count += result.count;
      for (const filePath of result.paths) paths.add(filePath);
    }

    return { profile, query: queries.join(', '), count, paths: [...paths] };
  }

  forget(profile: string, query: string, kind?: MemoryKind | string): MemoryMutationResult {
    return this.updateMatching(profile, query, entry => ({
      ...entry,
      status: 'superseded',
      updated_at: utcNow(),
    }), kind);
  }

  delete(profile: string, query: string, kind?: MemoryKind | string): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    const needle = this.normalizeQuery(profile, query);
    this.ensureProfile(profile);
    const normalizedKind = kind ? normalizeKind(kind) : undefined;
    let count = 0;
    const paths: string[] = [];

    for (const memoryKind of KIND_ORDER) {
      if (normalizedKind && normalizedKind !== memoryKind) continue;
      const filePath = this.jsonlPath(profile, memoryKind);
      if (!fs.existsSync(filePath)) continue;

      const lines = readJsonlLines(filePath, memoryKind);
      const next = lines.filter(line => {
        if (line.entry && entryMatchesQuery(line.entry, needle, normalizedKind)) {
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
    const cutoff = isSimpleMemoryPrompt(options.prompt ?? '')
      ? SIMPLE_PROMPT_PRIORITY_CUTOFF
      : options.thinking
        ? THINKING_PRIORITY_CUTOFF
        : NORMAL_PRIORITY_CUTOFF;
    const promptTokens = tokens(options.prompt ?? '');
    const nowTs = Date.now() / 1000;
    let candidates = [
      ...this.listEntries(profile),
      ...this.readLegacyEntries(profile),
    ].filter(entry => (
      entry.status === 'active'
      && !isExpired(entry, nowTs)
      && entry.priority <= cutoff
    ));

    candidates.sort((a, b) => compareMemoryRank(a, b, promptTokens));
    candidates = candidates.slice(0, Math.max(0, limit));
    if (contextLimit > 0) {
      const selected: MemoryEntry[] = [];
      for (const entry of candidates) {
        const trial = [...selected, entry];
        if (renderPromptMemory(trial).join('\n\n').length <= contextLimit) selected.push(entry);
      }
      candidates = selected;
    }

    return renderPromptMemory(candidates);
  }

  trimShortTerm(profile: string, sizeLimit: number): void {
    this.assertSafeProfileName(profile);
    if (sizeLimit <= 0) return;
    this.ensureProfile(profile);
    const filePath = this.jsonlPath(profile, 'auto_short');
    const lines = readJsonlLines(filePath, 'auto_short');
    const entries = lines
      .map(line => line.entry)
      .filter((entry): entry is MemoryEntry => entry !== undefined);
    if (serializedJsonlLength(entries) <= sizeLimit) return;

    let keep = entries.filter(entry => !isExpired(entry));
    if (keep.length === 0 && entries.length > 0) {
      keep = [entries.reduce((best, entry) => entry.priority < best.priority ? entry : best, entries[0])];
    }

    while (keep.length > 1 && serializedJsonlLength(keep) > sizeLimit) {
      const removable = keep.filter(entry => entry.priority !== 0);
      if (removable.length === 0) break;
      const victim = removable.reduce((worst, entry) => compareTrimRank(entry, worst) > 0 ? entry : worst, removable[0]);
      keep = keep.filter(entry => entry.id !== victim.id);
    }

    if (serializedJsonlLength(keep) > sizeLimit) {
      keep = keep.filter(entry => entry.priority === 0);
      if (keep.length === 0 && entries.length > 0) keep = [entries[entries.length - 1]];
    }

    const keepIds = new Set(keep.map(entry => entry.id));
    writeJsonlLines(filePath, lines.filter(line => !line.entry || keepIds.has(line.entry.id)));
  }

  private saveEntry(profile: string, entry: MemoryEntry | undefined): SaveEntryResult {
    if (!entry) throw MarifoldError.memoryInvalid('Memory entry is invalid.', profile);
    this.ensureProfile(profile);
    const filePath = this.jsonlPath(profile, entry.kind);
    const lines = readJsonlLines(filePath, entry.kind);
    const merge = mergeEntry(lines, entry);
    writeJsonlLines(filePath, merge.lines);
    return { created: merge.created, entry: merge.entry, path: filePath };
  }

  private updateMatching(
    profile: string,
    query: string,
    update: (entry: MemoryEntry) => MemoryEntry,
    kind?: MemoryKind | string,
  ): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    const needle = this.normalizeQuery(profile, query);
    this.ensureProfile(profile);
    const normalizedKind = kind ? normalizeKind(kind) : undefined;
    let count = 0;
    const paths: string[] = [];

    for (const memoryKind of KIND_ORDER) {
      if (normalizedKind && normalizedKind !== memoryKind) continue;
      const filePath = this.jsonlPath(profile, memoryKind);
      if (!fs.existsSync(filePath)) continue;

      let changed = false;
      const lines = readJsonlLines(filePath, memoryKind).map(line => {
        if (line.entry?.status === 'active' && entryMatchesQuery(line.entry, needle, normalizedKind)) {
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

  private readLegacyEntries(profile: string): MemoryEntry[] {
    const memoriesDir = this.memoriesDir(profile);
    const entries: MemoryEntry[] = [];
    for (const legacy of LEGACY_FILES) {
      const filePath = path.join(memoriesDir, legacy.fileName);
      if (!fs.existsSync(filePath)) continue;
      const now = utcNow();
      let currentDate = '';
      for (const rawLine of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const dateMatch = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(trimmed);
        if (dateMatch) {
          currentDate = dateMatch[1];
          continue;
        }
        if (trimmed.startsWith('#')) continue;
        entries.push({
          id: `legacy-${randomUUID()}`,
          kind: legacy.kind,
          text: currentDate ? `${currentDate}: ${trimmed}` : trimmed,
          priority: legacy.priority,
          confidence: 1,
          stability: legacy.kind === 'auto_short' ? 'session' : 'stable',
          status: 'active',
          source: 'system',
          source_type: 'system',
          scope: 'profile',
          reason: legacy.reason,
          created_at: now,
          updated_at: now,
          last_seen_at: now,
        });
      }
    }
    return dedupeEntries(entries);
  }

  private jsonlPath(profile: string, kind: MemoryKind): string {
    return path.join(this.memoriesDir(profile), JSONL_FILES[kind]);
  }

  private memoriesDir(profile: string): string {
    this.assertSafeProfileName(profile);
    return path.join(this.profilesDir, profile, 'memories');
  }

  private normalizeQuery(profile: string, query: string): string {
    const needle = normalizeText(query);
    if (!needle) throw MarifoldError.memoryInvalid('Memory query cannot be empty.', profile);
    return needle;
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
        const entry = entryFromRecord(parsed, fallbackKind, {
          source: 'manual',
          priority: DEFAULT_PRIORITY,
          confidence: 0.6,
          scope: 'profile',
        });
        return entry ? { raw, entry } : { raw };
      } catch {
        return { raw };
      }
    });
}

function entryFromRecord(
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
  if (!text) return undefined;

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
  if (conflictKey && !conflictKey.startsWith(`${kind}.`)) conflictKey = undefined;
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

function normalizePriority(
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
    if (kind === 'preferences') priority = 2;
    else if (kind === 'auto_short') priority = 3;
    else priority = 1;
  }
  return priority;
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
    const text = stringValue(value[key]);
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

function parseForgetPayload(payload: string): Array<{ query: string; kind?: MemoryKind }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  return forgetQueriesFromValue(parsed);
}

function forgetQueriesFromValue(value: unknown): Array<{ query: string; kind?: MemoryKind }> {
  if (typeof value === 'string') return value.trim() ? [{ query: value.trim() }] : [];
  if (!isRecord(value)) return [];

  const rawItems = value.forget ?? value.queries ?? value.items;
  if (Array.isArray(rawItems)) return rawItems.flatMap(forgetQueriesFromValue);

  const query = stringValue(value.query ?? value.conflict_key ?? value.text);
  const kind = normalizeKind(value.kind);
  return query ? [{ query, ...(kind ? { kind } : {}) }] : [];
}

function mergeEntry(lines: JsonLine[], incoming: MemoryEntry): { lines: JsonLine[]; created: boolean; entry: MemoryEntry } {
  const now = utcNow();
  incoming.updated_at = now;
  incoming.last_seen_at = now;
  const incomingKey = entryKey(incoming);

  for (const line of lines) {
    if (!line.entry || entryKey(line.entry) !== incomingKey) continue;
    line.entry = mergeDuplicate(line.entry, incoming, now);
    return { lines, created: false, entry: line.entry };
  }

  const groups = conflictGroups(incoming);
  if (groups.size > 0) {
    const conflicting = lines
      .map(line => line.entry)
      .filter((entry): entry is MemoryEntry => Boolean(entry && intersects(conflictGroups(entry), groups)));
    preserveMeetingDate(incoming, conflicting);
    const superseded: string[] = [];
    for (const entry of conflicting) {
      if (entry.status === 'active') {
        entry.status = 'superseded';
        entry.updated_at = now;
        superseded.push(entry.id);
      }
    }
    if (superseded.length > 0) incoming.supersedes = sortedUnique([...(incoming.supersedes ?? []), ...superseded]);
  }

  return {
    lines: [...lines, { raw: '', entry: incoming }],
    created: true,
    entry: incoming,
  };
}

function mergeDuplicate(existing: MemoryEntry, incoming: MemoryEntry, now: string): MemoryEntry {
  return {
    ...existing,
    priority: Math.min(existing.priority, incoming.priority),
    confidence: Math.max(existing.confidence, incoming.confidence),
    stability: incoming.stability === 'stable' || !isStability(existing.stability) ? incoming.stability : existing.stability,
    source: incoming.source === 'user_direct' ? incoming.source : existing.source,
    source_type: incoming.source_type === 'user' ? incoming.source_type : existing.source_type,
    scope: incoming.scope ?? existing.scope,
    status: 'active',
    updated_at: now,
    last_seen_at: now,
    ...(incoming.session_id ? { session_id: incoming.session_id } : {}),
    ...(incoming.task_id ? { task_id: incoming.task_id } : {}),
    ...(incoming.scope_id ? { scope_id: incoming.scope_id } : {}),
    ...(incoming.conflict_key ? { conflict_key: incoming.conflict_key } : {}),
    ...(incoming.evidence ? { evidence: incoming.evidence } : {}),
    ...(incoming.reason ? { reason: incoming.reason } : {}),
    ...(incoming.expires_at ? { expires_at: incoming.expires_at } : {}),
    supersedes: sortedUnique([...(existing.supersedes ?? []), ...(incoming.supersedes ?? [])]),
  };
}

function writeJsonlLines(filePath: string, lines: JsonLine[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lines
    .map(line => line.entry ? JSON.stringify(line.entry) : line.raw)
    .join('\n');
  atomicWrite(filePath, text ? `${text}\n` : '');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function renderPromptMemory(entries: MemoryEntry[]): string[] {
  const groups: Array<{ header: string; entries: MemoryEntry[] }> = [
    { header: '## Important User Memory', entries: entries.filter(entry => entry.kind === 'user') },
    {
      header: '## Preferences',
      entries: entries.filter(entry => entry.kind === 'preferences' && entry.reason !== 'Legacy notes.md fallback'),
    },
    {
      header: '## Legacy Notes Memory (read-only, lower authority than approved preferences)',
      entries: entries.filter(entry => entry.kind === 'preferences' && entry.reason === 'Legacy notes.md fallback'),
    },
    { header: '## Current Context', entries: entries.filter(entry => entry.kind === 'auto_short') },
  ];

  return groups.flatMap(group => {
    const lines = group.entries.map(formatMemoryEntry).filter(Boolean);
    return lines.length > 0 ? [`${group.header}\n\n${lines.join('\n')}`] : [];
  });
}

function formatMemoryEntry(entry: MemoryEntry): string {
  let line = formatBullet(entry.text);
  if (!line || entry.kind !== 'auto_short') return line;
  const dateText = meetingDate(entry.text);
  if (dateText) {
    line += ` (When answering about this, include the date word exactly: ${dateText}.)`;
  }
  return line;
}

function formatBullet(text: string): string {
  const stripped = text.trim();
  if (!stripped) return '';
  if (stripped.includes('\n') || stripped.startsWith('- ') || stripped.startsWith('* ')) return stripped;
  return `- ${stripped}`;
}

function compareMemoryRank(a: MemoryEntry, b: MemoryEntry, promptTokens: Set<string>): number {
  const ar = memoryRank(a, promptTokens);
  const br = memoryRank(b, promptTokens);
  for (let index = 0; index < ar.length; index += 1) {
    if (ar[index] !== br[index]) return ar[index] - br[index];
  }
  return 0;
}

function memoryRank(entry: MemoryEntry, promptTokens: Set<string>): [number, number, number, number] {
  const relevance = promptTokens.size > 0 ? intersectionSize(tokens(entry.text), promptTokens) : 0;
  return [
    entry.priority,
    -relevance,
    -entry.confidence,
    -timestamp(entry.last_seen_at || entry.updated_at || entry.created_at),
  ];
}

function compareTrimRank(a: MemoryEntry, b: MemoryEntry): number {
  const ar = trimRank(a);
  const br = trimRank(b);
  for (let index = 0; index < ar.length; index += 1) {
    if (ar[index] !== br[index]) return ar[index] - br[index];
  }
  return 0;
}

function trimRank(entry: MemoryEntry): [number, number, number, number] {
  return [
    entry.priority === 0 ? 0 : 1,
    entry.priority,
    entry.confidence,
    timestamp(entry.last_seen_at || entry.updated_at || entry.created_at),
  ];
}

function entryMatchesQuery(entry: MemoryEntry, query: string, kind?: MemoryKind): boolean {
  if (kind && entry.kind !== kind) return false;
  const conflictKey = normalizeConflictKey(query);
  const queryText = normalizeText(query);
  const queryTokens = tokens(queryText);
  const text = normalizeText(entry.text);
  const textTokens = tokens(entry.text);
  return Boolean(
    entry.id === query
    || normalizeText(entry.id).includes(queryText)
    || (conflictKey && conflictGroups(entry).has(conflictKey))
    || (queryText && text.includes(queryText))
    || (queryTokens.size > 0 && isSubset(queryTokens, textTokens)),
  );
}

function conflictGroups(entry: MemoryEntry): Set<string> {
  const groups = new Set<string>();
  const conflictKey = normalizeConflictKey(entry.conflict_key);
  if (conflictKey) {
    groups.add(conflictKey);
    if (conflictKey.endsWith('project_meeting_time')) groups.add(`${entry.kind}:meeting:project`);
    else if (conflictKey.endsWith('meeting_time')) groups.add(`${entry.kind}:meeting:general`);
  }

  const inferred = inferredConflictGroup(entry);
  if (inferred) {
    groups.add(inferred);
    if (inferred.includes(':meeting:')) {
      const parts = inferred.split(':');
      if (parts.length >= 4) groups.add(`${entry.kind}:meeting:${parts[parts.length - 1]}`);
    }
  }
  return groups;
}

function inferredConflictGroup(entry: MemoryEntry): string | undefined {
  const normalized = normalizeText(entry.text);
  if (entry.kind === 'user') {
    if (looksIdentityNameFact(entry.text)) return 'user.name';
    const favoriteKey = favoriteConflictKeyFromText(normalized);
    if (favoriteKey) return favoriteKey;
  }
  if (entry.kind === 'preferences' && looksResponsePreference(entry.text)) return 'preferences.reply_style';
  if (normalized.includes('meeting') && /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\b/.test(normalized)) {
    const date = meetingDate(entry.text) || 'unspecified';
    const topic = normalized.includes('project meeting') ? 'project' : 'general';
    return `${entry.kind}:meeting:${date}:${topic}`;
  }
  return undefined;
}

function favoriteConflictKeyFromText(text: string): string | undefined {
  const patterns = [
    /\b(?:the\s+)?user(?:'s)?\s+favou?rite\s+([a-z0-9][a-z0-9 _-]{0,40}?)\s+(?:is|=|:)\b/,
    /\bmy\s+favou?rite\s+([a-z0-9][a-z0-9 _-]{0,40}?)\s+(?:is|=|:)\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const slot = slotKey(match[1]);
    if (slot) return normalizeConflictKey(`user.favorite_${slot}`);
  }
  return undefined;
}

function preserveMeetingDate(incoming: MemoryEntry, conflicts: MemoryEntry[]): void {
  if (incoming.kind !== 'auto_short') return;
  const incomingText = normalizeText(incoming.text);
  if (!incomingText.includes('meeting') || meetingDate(incoming.text)) return;
  for (const entry of conflicts) {
    const dateText = meetingDate(entry.text);
    if (!dateText) continue;
    incoming.text = incoming.text.replace(/\b(meeting)(\s+at\s+)/i, `$1 ${dateText}$2`);
    return;
  }
}

function normalizeConflictKey(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  let key = raw
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/:/g, '.')
    .replace(/\s+/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  key = CONFLICT_KEY_ALIASES[key] ?? key;
  if (key.startsWith('user.preferred_') && key !== 'user.preferred_name') {
    key = `user.favorite_${key.slice('user.preferred_'.length)}`;
  }
  if (key.startsWith('user.fav_')) key = `user.favorite_${key.slice('user.fav_'.length)}`;
  key = key.replace(/favourite/g, 'favorite').replace(/colour/g, 'color');
  key = CONFLICT_KEY_ALIASES[key] ?? key;
  if (GENERIC_CONFLICT_KEYS.has(key)) return undefined;
  return CONFLICT_KEY_RE.test(key) ? key : undefined;
}

function normalizeKind(value: unknown): MemoryKind | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'user' || normalized === 'preferences' || normalized === 'auto_short') return normalized;
  if (normalized === 'pref' || normalized === 'prefs' || normalized === 'preference' || normalized === 'notes') return 'preferences';
  if (normalized === 'note' || normalized === 'short' || normalized === 'short_term' || normalized === 'session' || normalized === 'current' || normalized === 'auto') return 'auto_short';
  return undefined;
}

function normalizeStability(value: unknown, fallback: MemoryStability): MemoryStability {
  return isStability(value) ? value : fallback;
}

function isStability(value: unknown): value is MemoryStability {
  return value === 'stable' || value === 'evolving' || value === 'session' || value === 'ephemeral';
}

function normalizeSource(value: unknown, fallback: string): string {
  const source = stringValue(value);
  return /^[a-z][a-z0-9_:-]{0,60}$/.test(source) ? source : fallback;
}

function normalizeSourceType(value: unknown, fallback?: MemorySourceType): MemorySourceType {
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

function normalizeScope(value: unknown, fallback: MemoryScope): MemoryScope {
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

function sourceTypeFromSource(source: string): MemorySourceType {
  if (source === 'user_direct' || source === 'manual') return 'user';
  if (source === 'system') return 'system';
  if (source.startsWith('tool')) return 'tool';
  if (source.startsWith('file')) return 'file';
  if (source.startsWith('browser')) return 'browser';
  if (source.startsWith('external_agent')) return 'external_agent';
  return 'model';
}

function defaultStability(kind: MemoryKind): MemoryStability {
  return kind === 'auto_short' ? 'session' : 'evolving';
}

function defaultPriority(kind: MemoryKind, explicitDefault: number): number {
  return explicitDefault >= 0 && explicitDefault <= 10 ? explicitDefault : kind === 'auto_short' ? 5 : DEFAULT_PRIORITY;
}

function manualPriority(kind: MemoryKind): number {
  if (kind === 'user') return 1;
  if (kind === 'preferences') return 2;
  return 3;
}

function manualStability(kind: MemoryKind): MemoryStability {
  return kind === 'auto_short' ? 'session' : 'stable';
}

function manualReason(kind: MemoryKind): string {
  if (kind === 'user') return 'Manual durable user memory command.';
  if (kind === 'preferences') return 'Manual durable preference memory command.';
  return 'Manual short-term memory command.';
}

function looksTimeSensitive(text: string): boolean {
  const normalized = normalizeText(text);
  if (!/\b(today|tomorrow|tonight|meeting|deadline|appointment|reminder|schedule)\b/.test(normalized)) return false;
  return Boolean(
    /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\b/.test(normalized)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(normalized),
  );
}

function looksResponsePreference(text: string): boolean {
  const normalized = normalizeText(text);
  if (!/\b(prefer|prefers|preference|like|likes)\b/.test(normalized)) return false;
  return Boolean(
    /\b(reply|replies|answer|answers|response|responses|conversation|tone|style)\b/.test(normalized)
    || /\b(short|brief|concise|detailed|normal|casual|formal)\b/.test(normalized),
  );
}

function looksIdentityNameFact(text: string): boolean {
  const normalized = normalizeText(text);
  return Boolean(
    /\b(?:the\s+)?user(?:'s)?\s+name\s+is\b/.test(normalized)
    || /\buser\s+is\s+named\b/.test(normalized)
    || /^name\s*:/.test(normalized)
    || /\bpreferred\s+name\b/.test(normalized)
    || /\bcall\s+(?:the\s+)?user\b/.test(normalized),
  );
}

function isSimpleMemoryPrompt(prompt: string): boolean {
  const normalized = normalizeText(prompt);
  if (!normalized || normalized.length > 80) return false;
  return [
    /^(?:hi|hello|hey|yo|sup|hiya|howdy)[!. ]*$/i,
    /^(?:thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|got it|sounds good)[!. ]*$/i,
    /^(?:good morning|good afternoon|good evening|good night)[!. ]*$/i,
    /^(?:yes|no|yep|yeah|nope|sure|alright|all right)[!. ]*$/i,
  ].some(pattern => pattern.test(normalized));
}

function meetingDate(text: string): string {
  const match = /\b\d{4}-\d{2}-\d{2}\b|\btomorrow\b|\btoday\b|\btonight\b/i.exec(text);
  return match ? match[0].toLowerCase() : '';
}

function serializedJsonlLength(entries: MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 0);
}

function dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const deduped = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const existing = deduped.get(key);
    if (!existing || compareMemoryRank(entry, existing, new Set()) < 0) deduped.set(key, entry);
  }
  return [...deduped.values()];
}

function entryKey(entry: MemoryEntry): string {
  return `${entry.kind}:${normalizeText(entry.text)}`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').replace(/[.;]+$/g, '');
}

function slotKey(value: string): string {
  let key = value.trim().toLowerCase().replace(/colour/g, 'color');
  key = key.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (key.startsWith('fav_')) key = `favorite_${key.slice(4)}`;
  return key.slice(0, 40).replace(/^_+|_+$/g, '');
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function isExpired(entry: MemoryEntry, nowTs = Date.now() / 1000): boolean {
  if (!entry.expires_at) return false;
  const expires = timestamp(entry.expires_at);
  return expires > 0 && expires <= nowTs;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function clampInteger(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(low, Math.min(high, number));
}

function clampNumber(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(low, Math.min(high, number));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
