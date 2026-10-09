import * as path from 'path';
import type Database from 'better-sqlite3';
import type { ImageInput } from '@priest-ai/core';
import type { SessionTurnSummary } from '../config/ConfigSchema';

// User-turn image attachments stored beside priest's session tables, keyed by
// session and user-turn index.

export const ATTACHMENTS_TABLE = 'marifold_turn_attachments';
export const DEFAULT_IMAGE_MEDIA_TYPE = 'image/jpeg';

export function ensureAttachmentsTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${ATTACHMENTS_TABLE} (
        session_id TEXT NOT NULL,
        user_turn_index INTEGER NOT NULL,
        attachment_index INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        data TEXT,
        url TEXT,
        PRIMARY KEY (session_id, user_turn_index, attachment_index),
        CHECK ((data IS NOT NULL AND url IS NULL) OR (data IS NULL AND url IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_marifold_turn_attachments_session
        ON ${ATTACHMENTS_TABLE} (session_id, user_turn_index);
    `);
  // Empty data satisfies the legacy source constraint for path-backed records;
  // no image bytes are retained. Existing embedded records remain unchanged.
  if (!hasAttachmentPaths(db)) { db.exec(`ALTER TABLE ${ATTACHMENTS_TABLE} ADD COLUMN source_path TEXT`); }
}

export function hasAttachmentPaths(db: Database.Database): boolean {
  return (db.pragma(`table_info(${ATTACHMENTS_TABLE})`) as Array<{ name: string }>).some(column => column.name === 'source_path');
}

export function hasAttachmentsTable(db: Database.Database): boolean {
  return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(ATTACHMENTS_TABLE) !== undefined;
}

export function listAttachments(
  db: Database.Database,
  sessionId: string,
): Map<number, NonNullable<SessionTurnSummary['attachments']>> {
  const byTurn = new Map<number, NonNullable<SessionTurnSummary['attachments']>>();
  if (!hasAttachmentsTable(db)) { return byTurn; }
  const rows = db.prepare(`
      SELECT
        a.user_turn_index AS userTurnIndex,
        a.attachment_index AS attachmentIndex,
        a.media_type AS mediaType,
        a.data IS NOT NULL AS embedded,
        a.url AS url
      FROM ${ATTACHMENTS_TABLE} a
      WHERE a.session_id = ?
      ORDER BY a.user_turn_index ASC, a.attachment_index ASC
    `).all(sessionId) as Array<{
    userTurnIndex: number;
    attachmentIndex: number;
    mediaType: string;
    embedded: number;
    url: string | null;
  }>;
  for (const row of rows) {
    const current = byTurn.get(row.userTurnIndex) ?? [];
    current.push({
      kind: 'image',
      mediaType: row.mediaType,
      ...(row.embedded === 1 ? {
        ref: {
          userTurnIndex: row.userTurnIndex,
          attachmentIndex: row.attachmentIndex,
        },
      } : {}),
      ...(row.url !== null ? { url: row.url } : {}),
    });
    byTurn.set(row.userTurnIndex, current);
  }
  return byTurn;
}

export function replaceUserTurnAttachments(
  db: Database.Database,
  sessionId: string,
  userTurnIndex: number,
  images: ImageInput[],
): void {
  const persistable = images.filter(
    (image): image is ImageInput & ({ data: string } | { url: string } | { path: string }) => Boolean(image.path || image.data || image.url),
  );
  if (persistable.length > 0) { ensureAttachmentsTable(db); }
  if (!hasAttachmentsTable(db)) { return; }
  db.prepare(`
      DELETE FROM ${ATTACHMENTS_TABLE}
      WHERE session_id = ? AND user_turn_index = ?
    `).run(sessionId, userTurnIndex);
  if (persistable.length === 0) { return; }
  const insert = db.prepare(`
      INSERT INTO ${ATTACHMENTS_TABLE}
        (session_id, user_turn_index, attachment_index, media_type, data, url, source_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  for (const [index, image] of persistable.entries()) {
    insert.run(
      sessionId,
      userTurnIndex,
      index,
      image.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE,
      image.path ? '' : image.data ?? null,
      image.path ? null : image.url ?? null,
      image.path ? path.resolve(image.path) : null,
    );
  }
}

export function deleteAttachmentsForSession(db: Database.Database, sessionId: string): void {
  if (!hasAttachmentsTable(db)) { return; }
  db.prepare(`DELETE FROM ${ATTACHMENTS_TABLE} WHERE session_id = ?`).run(sessionId);
}
