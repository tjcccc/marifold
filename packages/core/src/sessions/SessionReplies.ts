import type Database from 'better-sqlite3';
import type { ImageInput } from '@priest-ai/core';
import type { ResponseMetrics } from './ResponseMetrics';
import { hasTable, REPLY_METRICS_TABLE, replyKey, RESPONSE_METRICS_TABLE, upsertResponseMetrics } from './ResponseMetricsTable';
import { replaceUserTurnAttachments } from './SessionAttachmentsTable';
import { COMPACTION_METADATA_KEY } from './SessionCompaction';

/**
 * Several replies to one message. In a project session each addressed profile
 * answers the same user turn in its own run, so a session can hold consecutive
 * assistant turns. A reply is addressed by its zero-based user-turn ordinal and
 * its ordinal among that turn's replies; both survive Priest's rewrites of the
 * turn rows. Project sessions record each reply's speaker; a reply without a
 * speaker row is the session profile's.
 */
export const REPLY_SPEAKERS_TABLE = 'marifold_reply_speakers';

export interface ReplyPosition {
  userTurnIndex: number;
  replyIndex: number;
}

/** A reply's side rows: metrics of a completed answer, and who gave it. */
export interface ReplyRecord {
  responseMetrics?: ResponseMetrics;
  speaker?: string;
}

/** Which replies' rows to delete: every reply from a user turn on (truncation),
 * or one user turn's replies from `fromReply` on (a regenerated answer). */
export type ReplyScope = { fromUserTurn: number } | { userTurn: number; fromReply: number };

const NOW = "strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')";

function ensureReplySpeakersTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${REPLY_SPEAKERS_TABLE} (
      session_id TEXT NOT NULL,
      user_turn_index INTEGER NOT NULL CHECK (user_turn_index >= 0),
      reply_index INTEGER NOT NULL CHECK (reply_index >= 0),
      profile TEXT NOT NULL,
      PRIMARY KEY (session_id, user_turn_index, reply_index)
    )
  `);
}

/** Where the newest assistant turn sits; undefined before the first user turn. */
export function lastReplyPosition(db: Database.Database, sessionId: string): ReplyPosition | undefined {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM turns WHERE session_id = ? AND role = 'user') AS users,
      (SELECT COUNT(*) FROM turns WHERE session_id = ? AND role = 'assistant'
        AND id > (SELECT MAX(id) FROM turns WHERE session_id = ? AND role = 'user')) AS replies
  `).get(sessionId, sessionId, sessionId) as { users: number; replies: number };
  if (row.users === 0) { return undefined; }
  return { userTurnIndex: row.users - 1, replyIndex: Math.max(0, row.replies - 1) };
}

/** Write a reply's side rows, clearing whichever the record leaves out. */
export function recordReply(db: Database.Database, sessionId: string, at: ReplyPosition, record: ReplyRecord): void {
  if (record.responseMetrics) {
    upsertResponseMetrics(db, sessionId, at.userTurnIndex, record.responseMetrics, at.replyIndex);
  } else {
    deleteRows(db, sessionId, at.replyIndex > 0 ? [REPLY_METRICS_TABLE] : [RESPONSE_METRICS_TABLE], at);
  }
  if (record.speaker) {
    ensureReplySpeakersTable(db);
    db.prepare(`
      INSERT INTO ${REPLY_SPEAKERS_TABLE} (session_id, user_turn_index, reply_index, profile) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, user_turn_index, reply_index) DO UPDATE SET profile = excluded.profile
    `).run(sessionId, at.userTurnIndex, at.replyIndex, record.speaker);
  } else {
    deleteRows(db, sessionId, [REPLY_SPEAKERS_TABLE], at);
  }
}

/** A session's recorded speakers keyed by `replyKey`. */
export function listReplySpeakers(db: Database.Database, sessionId: string): Map<string, string> {
  if (!hasTable(db, REPLY_SPEAKERS_TABLE)) { return new Map(); }
  const rows = db.prepare(`SELECT user_turn_index AS u, reply_index AS r, profile FROM ${REPLY_SPEAKERS_TABLE} WHERE session_id = ?`)
    .all(sessionId) as Array<{ u: number; r: number; profile: string }>;
  return new Map(rows.map(row => [replyKey(row.u, row.r), row.profile]));
}

/** Delete reply metrics and speakers: the whole session's, or a scope's. */
export function deleteReplyRows(db: Database.Database, sessionId: string, scope?: ReplyScope): void {
  deleteRows(db, sessionId, [RESPONSE_METRICS_TABLE, REPLY_METRICS_TABLE, REPLY_SPEAKERS_TABLE], scope);
}

export function renameReplyRows(db: Database.Database, from: string, to: string): void {
  for (const table of [RESPONSE_METRICS_TABLE, REPLY_METRICS_TABLE, REPLY_SPEAKERS_TABLE]) {
    if (hasTable(db, table)) { db.prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(to, from); }
  }
}

/** Keep a renamed profile's replies attributed to it. */
export function renameReplySpeaker(db: Database.Database, from: string, to: string): void {
  if (hasTable(db, REPLY_SPEAKERS_TABLE)) { db.prepare(`UPDATE ${REPLY_SPEAKERS_TABLE} SET profile = ? WHERE profile = ?`).run(to, from); }
}

export interface ExchangeReplacement extends ReplyRecord {
  userText: string;
  assistantText: string;
  /** Replaces the prompt's attachments only when given. */
  images?: ImageInput[];
}

/** Replace one persisted exchange in place: the prompt and its first reply.
 * Later replies to the prompt are removed (it is being answered afresh); later
 * exchanges keep their order. An unanswered prompt gains an answer only when
 * newest. Runs inside the caller's open database. */
export function replaceExchange(db: Database.Database, sessionId: string, userTurnIndex: number, replacement: ExchangeReplacement): { found: boolean; replaced: boolean } {
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) { return { found: false, replaced: false }; }
  const exchange = exchangeRows(db, sessionId, userTurnIndex);
  if (!exchange) { return { found: true, replaced: false }; }
  const [first, ...later] = exchange.replies;
  if (first === undefined && exchange.nextUserId !== undefined) { return { found: true, replaced: false }; }
  db.transaction(() => {
    db.prepare('UPDATE turns SET content = ? WHERE id = ?').run(replacement.userText, exchange.userId);
    if (first !== undefined) { db.prepare('UPDATE turns SET content = ? WHERE id = ?').run(replacement.assistantText, first); } else {
      db.prepare(`INSERT INTO turns (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ${NOW})`).run(sessionId, replacement.assistantText);
    }
    for (const id of later) { db.prepare('DELETE FROM turns WHERE id = ?').run(id); }
    if (replacement.images !== undefined) { replaceUserTurnAttachments(db, sessionId, userTurnIndex, replacement.images); }
    deleteReplyRows(db, sessionId, { userTurn: userTurnIndex, fromReply: 1 });
    recordReply(db, sessionId, { userTurnIndex, replyIndex: 0 }, replacement);
    touchSession(db, sessionId, true);
  })();
  return { found: true, replaced: true };
}

/** Add another reply to a saved user turn, after its existing replies. Turns
 * after it are re-inserted behind the new one (fresh ids keep their order),
 * so a regenerated message mid-session gets its replies back in place.
 * Undefined when the user turn is missing. */
export function addReply(db: Database.Database, sessionId: string, userTurnIndex: number, content: string, record: ReplyRecord): ReplyPosition | undefined {
  const exchange = exchangeRows(db, sessionId, userTurnIndex);
  if (!exchange) { return undefined; }
  const at = { userTurnIndex, replyIndex: exchange.replies.length };
  const columns = (db.pragma('table_info(turns)') as Array<{ name: string }>).map(column => column.name).filter(name => name !== 'id');
  db.transaction(() => {
    const following = exchange.nextUserId === undefined ? [] : db.prepare(`SELECT ${columns.join(', ')} FROM turns WHERE session_id = ? AND id >= ? ORDER BY id`)
      .all(sessionId, exchange.nextUserId) as Array<Record<string, unknown>>;
    if (exchange.nextUserId !== undefined) { db.prepare('DELETE FROM turns WHERE session_id = ? AND id >= ?').run(sessionId, exchange.nextUserId); }
    db.prepare(`INSERT INTO turns (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ${NOW})`).run(sessionId, content);
    const reinsert = db.prepare(`INSERT INTO turns (${columns.join(', ')}) VALUES (${columns.map(name => `@${name}`).join(', ')})`);
    for (const row of following) { reinsert.run(row); }
    recordReply(db, sessionId, at, record);
    // A summary counts raw turns: one covering the shifted turns no longer lines up.
    touchSession(db, sessionId, following.length > 0);
  })();
  return at;
}

/** A user turn's row id, its replies' ids, and the next user turn's id. */
function exchangeRows(db: Database.Database, sessionId: string, userTurnIndex: number): { userId: number; replies: number[]; nextUserId?: number } | undefined {
  const user = db.prepare("SELECT id FROM turns WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1 OFFSET ?")
    .get(sessionId, userTurnIndex) as { id: number } | undefined;
  if (!user) { return undefined; }
  const nextUser = db.prepare("SELECT id FROM turns WHERE session_id = ? AND role = 'user' AND id > ? ORDER BY id LIMIT 1")
    .get(sessionId, user.id) as { id: number } | undefined;
  const replies = db.prepare(`SELECT id FROM turns WHERE session_id = ? AND role = 'assistant' AND id > ? ${nextUser ? 'AND id < ?' : ''} ORDER BY id`)
    .all(...(nextUser ? [sessionId, user.id, nextUser.id] : [sessionId, user.id])) as Array<{ id: number }>;
  return { userId: user.id, replies: replies.map(row => row.id), ...(nextUser ? { nextUserId: nextUser.id } : {}) };
}

function touchSession(db: Database.Database, sessionId: string, dropCompaction: boolean): void {
  if (!dropCompaction) {
    db.prepare(`UPDATE sessions SET updated_at = ${NOW} WHERE id = ?`).run(sessionId);
    return;
  }
  const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as { metadata: string | null } | undefined;
  const metadata = JSON.parse(row?.metadata || '{}') as Record<string, unknown>;
  delete metadata[COMPACTION_METADATA_KEY];
  db.prepare(`UPDATE sessions SET updated_at = ${NOW}, metadata = ? WHERE id = ?`).run(JSON.stringify(metadata), sessionId);
}

/** The original metrics table holds only first replies and has no reply column. */
function deleteRows(db: Database.Database, sessionId: string, tables: string[], scope?: ReplyScope | ReplyPosition): void {
  for (const table of tables) {
    if (!hasTable(db, table)) { continue; }
    const firstRepliesOnly = table === RESPONSE_METRICS_TABLE;
    if (scope === undefined) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    } else if ('fromUserTurn' in scope) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND user_turn_index >= ?`).run(sessionId, scope.fromUserTurn);
    } else {
      const [userTurn, fromReply, exact] = 'fromReply' in scope ? [scope.userTurn, scope.fromReply, false] : [scope.userTurnIndex, scope.replyIndex, true];
      if (firstRepliesOnly) {
        if (fromReply === 0) { db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND user_turn_index = ?`).run(sessionId, userTurn); }
      } else {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND user_turn_index = ? AND reply_index ${exact ? '=' : '>='} ?`).run(sessionId, userTurn, fromReply);
      }
    }
  }
}
