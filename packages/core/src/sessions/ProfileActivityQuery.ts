import type Database from 'better-sqlite3';
import { ensureProfileDisplayTable, PROFILE_DISPLAY_TABLE } from './SessionDisplayTables';
import { ensureProjectSessionsTable, projectSessionFilter } from './ProjectSessionsTable';

export interface ProfileActivitySummary {
  profileName: string;
  pinned?: boolean;
  updatedAt?: string;
  preview?: string;
}

const PREVIEW_MAX_CHARS = 80;

/** Contact-list metadata for every profile represented either by a session or
 * a pinned display row. The profile's latest own session (never a project
 * session, which other profiles answer in too) sets activity and preview. */
export function profileActivity(db: Database.Database): ProfileActivitySummary[] {
  ensureProfileDisplayTable(db);
  ensureProjectSessionsTable(db);
  const ownSession = projectSessionFilter('latest');
  const rows = db.prepare(`
    SELECT
      p.profile_name AS profileName,
      p.pinned AS pinned,
      s.updated_at AS updatedAt,
      (
        SELECT content
        FROM turns
        WHERE session_id = s.id AND role = 'assistant'
        ORDER BY id DESC
        LIMIT 1
      ) AS response
    FROM ${PROFILE_DISPLAY_TABLE} p
    LEFT JOIN sessions s ON s.id = (
      SELECT latest.id
      FROM sessions latest
      WHERE latest.profile_name = p.profile_name AND ${ownSession}
      ORDER BY latest.updated_at DESC, latest.id DESC
      LIMIT 1
    )
    UNION ALL
    SELECT
      s.profile_name AS profileName,
      0 AS pinned,
      s.updated_at AS updatedAt,
      (
        SELECT content
        FROM turns
        WHERE session_id = s.id AND role = 'assistant'
        ORDER BY id DESC
        LIMIT 1
      ) AS response
    FROM sessions s
    WHERE s.id = (
      SELECT latest.id
      FROM sessions latest
      WHERE latest.profile_name = s.profile_name AND ${ownSession}
      ORDER BY latest.updated_at DESC, latest.id DESC
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${PROFILE_DISPLAY_TABLE} p
      WHERE p.profile_name = s.profile_name
    )
  `).all() as Array<{
    profileName: string;
    pinned: number;
    updatedAt: string | null;
    response: string | null;
  }>;
  return rows.map(row => {
    const preview = row.response ? firstLinePreview(row.response) : '';
    return {
      profileName: row.profileName,
      ...(row.pinned === 1 ? { pinned: true } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(preview ? { preview } : {}),
    };
  });
}

function firstLinePreview(content: string): string {
  const first = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '') ?? '';
  if (first.length <= PREVIEW_MAX_CHARS) { return first; }
  return `${first.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}
