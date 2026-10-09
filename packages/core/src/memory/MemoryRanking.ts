import type { MemoryEntry, MemoryKind } from './MemoryTypes';
import { entryKey, intersectionSize, isSubset, meetingDate, normalizeText, timestamp, tokens } from './MemoryText';
import { conflictGroups, normalizeConflictKey } from './MemoryConflicts';

// Ranking, trimming, deduplicating, matching, and rendering memory for prompts.

export function renderPromptMemory(entries: MemoryEntry[]): string[] {
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

export function formatMemoryEntry(entry: MemoryEntry): string {
  let line = formatBullet(entry.text);
  if (!line || entry.kind !== 'auto_short') { return line; }
  const dateText = meetingDate(entry.text);
  if (dateText) {
    line += ` (When answering about this, include the date word exactly: ${dateText}.)`;
  }
  return line;
}

export function formatBullet(text: string): string {
  const stripped = text.trim();
  if (!stripped) { return ''; }
  if (stripped.includes('\n') || stripped.startsWith('- ') || stripped.startsWith('* ')) { return stripped; }
  return `- ${stripped}`;
}

export function compareMemoryRank(a: MemoryEntry, b: MemoryEntry, promptTokens: Set<string>): number {
  const ar = memoryRank(a, promptTokens);
  const br = memoryRank(b, promptTokens);
  for (let index = 0; index < ar.length; index += 1) {
    if (ar[index] !== br[index]) { return ar[index] - br[index]; }
  }
  return 0;
}

export function memoryRank(entry: MemoryEntry, promptTokens: Set<string>): [number, number, number, number] {
  const relevance = promptTokens.size > 0 ? intersectionSize(tokens(entry.text), promptTokens) : 0;
  return [
    entry.priority,
    -relevance,
    -entry.confidence,
    -timestamp(entry.last_seen_at || entry.updated_at || entry.created_at),
  ];
}

export function compareTrimRank(a: MemoryEntry, b: MemoryEntry): number {
  const ar = trimRank(a);
  const br = trimRank(b);
  for (let index = 0; index < ar.length; index += 1) {
    if (ar[index] !== br[index]) { return ar[index] - br[index]; }
  }
  return 0;
}

export function trimRank(entry: MemoryEntry): [number, number, number, number] {
  return [
    entry.priority === 0 ? 0 : 1,
    entry.priority,
    entry.confidence,
    timestamp(entry.last_seen_at || entry.updated_at || entry.created_at),
  ];
}

export function entryMatchesQuery(entry: MemoryEntry, query: string, kind?: MemoryKind): boolean {
  if (kind && entry.kind !== kind) { return false; }
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

export function dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const deduped = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const existing = deduped.get(key);
    if (!existing || compareMemoryRank(entry, existing, new Set()) < 0) { deduped.set(key, entry); }
  }
  return [...deduped.values()];
}
