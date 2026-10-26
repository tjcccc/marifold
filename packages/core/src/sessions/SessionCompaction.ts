import type Database from 'better-sqlite3';

// The running summary Priest replays for chat (`metadata.__compaction`), also
// written by agent-mode compaction. Only the metadata column changes, so turns
// saved meanwhile are never rewritten.

export const COMPACTION_METADATA_KEY = '__compaction';

export interface SessionCompactionState {
  summary?: string;
  /** Turns [0, summarizedThrough) are folded into `summary`. */
  summarizedThrough?: number;
}

export function readSessionCompaction(db: Database.Database, sessionId: string): SessionCompactionState | undefined {
  const raw = (metadataOf(db, sessionId) ?? {})[COMPACTION_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
  const state = raw as Record<string, unknown>;
  return {
    ...(typeof state.summary === 'string' ? { summary: state.summary } : {}),
    ...(typeof state.summarizedThrough === 'number' ? { summarizedThrough: state.summarizedThrough } : {}),
  };
}

/** Merge a new summary into the session's compaction state (keeping Priest's
 * other fields, such as `lastInputTokens`). */
export function writeSessionCompaction(db: Database.Database, sessionId: string, update: Required<SessionCompactionState>): SessionCompactionState | undefined {
  const metadata = metadataOf(db, sessionId);
  if (!metadata) { return undefined; }
  const previous = metadata[COMPACTION_METADATA_KEY];
  metadata[COMPACTION_METADATA_KEY] = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    ...update,
    updatedAt: new Date().toISOString(),
  };
  db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), sessionId);
  return update;
}

function metadataOf(db: Database.Database, sessionId: string): Record<string, unknown> | undefined {
  const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as { metadata: string } | undefined;
  if (!row) { return undefined; }
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
