import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MarifoldError } from '../errors/MarifoldError';
import type { MemoryEntry, MemoryKind, MemoryListOptions, MemoryMutationResult, MemoryRememberOptions, MemoryRememberResult, MemorySaveInput, MemorySaveResult, MemoryScaffoldFile } from './MemoryTypes';
import { isExpired, isSimpleMemoryPrompt, normalizeText, tokens, utcNow } from './MemoryText';
import { DEFAULT_PRIORITY, entryFromRecord, manualPriority, manualReason, manualStability, normalizeKind, parseForgetPayload, parseSavePayload } from './MemoryRecords';
import { readJsonlLines, serializedJsonlLength, writeJsonlLines } from './MemoryJsonl';
import { compareMemoryRank, compareTrimRank, dedupeEntries, entryMatchesQuery, renderPromptMemory } from './MemoryRanking';
import { mergeEntry } from './MemoryMerge';
import { extractPromptMemoryInputs } from './MemoryControls';

export type {
  MemoryKind,
  MemoryStatus,
  MemoryScope,
  MemorySourceType,
  MemoryStability,
  MemoryEntry,
  MemoryScaffoldFile,
  MemoryRememberOptions,
  MemoryRememberResult,
  MemoryMutationResult,
  MemorySaveInput,
  MemorySaveResult,
  MemoryListOptions,
} from './MemoryTypes';

interface SaveEntryResult {
  created: boolean;
  entry: MemoryEntry;
  path: string;
}

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

const DEFAULT_CONTEXT_LIMIT = 2400;

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

export function ensureProfileMemoryFiles(profileDir: string): MemoryScaffoldFile[] {
  const memoriesDir = path.join(profileDir, 'memories');
  fs.mkdirSync(memoriesDir, { recursive: true });
  return KIND_ORDER.map(kind => {
    const filePath = path.join(memoriesDir, JSONL_FILES[kind]);
    if (fs.existsSync(filePath)) { return { path: filePath, status: 'kept' }; }
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
    if (!trimmed) { throw MarifoldError.memoryInvalid('Memory text cannot be empty.', profile); }

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

  /** `/remember <text>`: a recognizable fact (name, favorite, preference,
   * meeting) is saved with its conflict key, so it replaces the older value;
   * anything else is kept verbatim as short-term memory. */
  rememberStatement(profile: string, text: string, options: Pick<MemoryRememberOptions, 'sessionId'> = {}): MemoryRememberResult {
    const inputs = extractPromptMemoryInputs(text);
    if (inputs.length === 0) { return this.remember(profile, 'auto_short', text, options); }
    const result = this.save(profile, inputs, options);
    const entry = result.entries[0];
    if (!entry) { return this.remember(profile, 'auto_short', text, options); }
    // More than one statement ("my name is Jack and I'm on project Atlas"): keep the whole text too.
    if (/[;!?]\s*\S|\.\s+\S|,\s*\S|\band\b|\balso\b/i.test(text.trim())) { this.remember(profile, 'auto_short', text, options); }
    return { profile, kind: entry.kind, path: this.jsonlPath(profile, entry.kind), entry, created: result.created > 0 };
  }

  save(profile: string, inputs: MemorySaveInput[], options: Pick<MemoryRememberOptions, 'sessionId' | 'taskId'> = {}): MemorySaveResult {
    this.assertSafeProfileName(profile);
    let created = 0;
    let skipped = 0;
    const entries: MemoryEntry[] = [];
    const paths = new Set<string>();

    for (const input of inputs) {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) { continue; }
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
      if (!entry) { continue; }
      const result = this.saveEntry(profile, entry);
      if (result.created) { created += 1; }
      else { skipped += 1; }
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
      for (const filePath of result.paths) { paths.add(filePath); }
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
      if (normalizedKind && normalizedKind !== memoryKind) { continue; }
      const filePath = this.jsonlPath(profile, memoryKind);
      if (!fs.existsSync(filePath)) { continue; }

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

  /** Supersede exactly one entry by id (a per-row Forget — no fuzzy matching,
   * unlike `forget`'s query semantics). */
  /** Bring back a forgotten (superseded) entry. An active entry holding the
   * same conflict key is forgotten in its place, so one value stays current. */
  restoreById(profile: string, id: string): MemoryMutationResult {
    const target = this.listEntries(profile).find(entry => entry.id === id);
    if (target?.conflict_key) {
      for (const other of this.listEntries(profile)) {
        if (other.id !== id && other.status === 'active' && other.conflict_key === target.conflict_key) { this.forgetById(profile, other.id); }
      }
    }
    return this.mutateById(profile, id, entry => ({ ...entry, status: 'active', updated_at: utcNow() }));
  }

  forgetById(profile: string, id: string): MemoryMutationResult {
    return this.mutateById(profile, id, entry => ({
      ...entry,
      status: 'superseded',
      updated_at: utcNow(),
    }));
  }

  /** Permanently remove exactly one entry by id (a per-row Delete). */
  deleteById(profile: string, id: string): MemoryMutationResult {
    return this.mutateById(profile, id, () => undefined);
  }

  /** Exact-id mutation across all kinds: update returning undefined removes the line. */
  private mutateById(
    profile: string,
    id: string,
    update: (entry: MemoryEntry) => MemoryEntry | undefined,
  ): MemoryMutationResult {
    this.assertSafeProfileName(profile);
    this.ensureProfile(profile);
    let count = 0;
    const paths: string[] = [];

    for (const memoryKind of KIND_ORDER) {
      const filePath = this.jsonlPath(profile, memoryKind);
      if (!fs.existsSync(filePath)) { continue; }

      let changed = false;
      const lines = readJsonlLines(filePath, memoryKind).flatMap(line => {
        if (line.entry?.id !== id) { return [line]; }
        count += 1;
        changed = true;
        const updated = update(line.entry);
        return updated === undefined ? [] : [{ entry: updated, raw: line.raw }];
      });

      if (changed) {
        writeJsonlLines(filePath, lines);
        paths.push(filePath);
      }
    }

    return { profile, query: id, count, paths };
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
        if (renderPromptMemory(trial).join('\n\n').length <= contextLimit) { selected.push(entry); }
      }
      candidates = selected;
    }

    return renderPromptMemory(candidates);
  }

  trimShortTerm(profile: string, sizeLimit: number): void {
    this.assertSafeProfileName(profile);
    if (sizeLimit <= 0) { return; }
    this.ensureProfile(profile);
    const filePath = this.jsonlPath(profile, 'auto_short');
    const lines = readJsonlLines(filePath, 'auto_short');
    const entries = lines
      .map(line => line.entry)
      .filter((entry): entry is MemoryEntry => entry !== undefined);
    if (serializedJsonlLength(entries) <= sizeLimit) { return; }

    let keep = entries.filter(entry => !isExpired(entry));
    if (keep.length === 0 && entries.length > 0) {
      keep = [entries.reduce((best, entry) => entry.priority < best.priority ? entry : best, entries[0])];
    }

    while (keep.length > 1 && serializedJsonlLength(keep) > sizeLimit) {
      const removable = keep.filter(entry => entry.priority !== 0);
      if (removable.length === 0) { break; }
      const victim = removable.reduce((worst, entry) => compareTrimRank(entry, worst) > 0 ? entry : worst, removable[0]);
      keep = keep.filter(entry => entry.id !== victim.id);
    }

    if (serializedJsonlLength(keep) > sizeLimit) {
      keep = keep.filter(entry => entry.priority === 0);
      if (keep.length === 0 && entries.length > 0) { keep = [entries[entries.length - 1]]; }
    }

    const keepIds = new Set(keep.map(entry => entry.id));
    writeJsonlLines(filePath, lines.filter(line => !line.entry || keepIds.has(line.entry.id)));
  }

  private saveEntry(profile: string, entry: MemoryEntry | undefined): SaveEntryResult {
    if (!entry) { throw MarifoldError.memoryInvalid('Memory entry is invalid.', profile); }
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
      if (normalizedKind && normalizedKind !== memoryKind) { continue; }
      const filePath = this.jsonlPath(profile, memoryKind);
      if (!fs.existsSync(filePath)) { continue; }

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
      if (!fs.existsSync(filePath)) { continue; }
      const now = utcNow();
      let currentDate = '';
      for (const rawLine of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) { continue; }
        const dateMatch = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(trimmed);
        if (dateMatch) {
          currentDate = dateMatch[1];
          continue;
        }
        if (trimmed.startsWith('#')) { continue; }
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
    if (!needle) { throw MarifoldError.memoryInvalid('Memory query cannot be empty.', profile); }
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
