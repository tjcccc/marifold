import type { JsonLine, MemoryEntry } from './MemoryTypes';
import { entryKey, intersects, sortedUnique, utcNow } from './MemoryText';
import { conflictGroups, preserveMeetingDate } from './MemoryConflicts';
import { isStability } from './MemoryRecords';

// Merging a new memory into a JSONL file: duplicate updates and conflict-key supersession.

export function mergeEntry(lines: JsonLine[], incoming: MemoryEntry): { lines: JsonLine[]; created: boolean; entry: MemoryEntry } {
  const now = utcNow();
  incoming.updated_at = now;
  incoming.last_seen_at = now;
  const incomingKey = entryKey(incoming);

  for (const line of lines) {
    if (!line.entry || entryKey(line.entry) !== incomingKey) { continue; }
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
    if (superseded.length > 0) { incoming.supersedes = sortedUnique([...(incoming.supersedes ?? []), ...superseded]); }
  }

  return {
    lines: [...lines, { raw: '', entry: incoming }],
    created: true,
    entry: incoming,
  };
}

export function mergeDuplicate(existing: MemoryEntry, incoming: MemoryEntry, now: string): MemoryEntry {
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
