import type Database from 'better-sqlite3';

// Sidebar-only display state: session titles, pins, and archive flags, and
// profile pins. None of it changes session ids, turns, or model context.

export const SESSION_DISPLAY_TABLE = 'marifold_session_display';
export const PROFILE_DISPLAY_TABLE = 'marifold_profile_display';

export function ensureSessionDisplayTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${SESSION_DISPLAY_TABLE} (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
      )
    `);
  const columns = db.prepare(`PRAGMA table_info(${SESSION_DISPLAY_TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'archived')) {
    db.exec(`ALTER TABLE ${SESSION_DISPLAY_TABLE} ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))`);
  }
}

export function ensureProfileDisplayTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${PROFILE_DISPLAY_TABLE} (
        profile_name TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
      )
    `);
}

export function hasProfileDisplayTable(db: Database.Database): boolean {
  return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(PROFILE_DISPLAY_TABLE) !== undefined;
}

export function hasSessionDisplayTable(db: Database.Database): boolean {
  return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(SESSION_DISPLAY_TABLE) !== undefined;
}

export function deleteDisplayForSession(db: Database.Database, sessionId: string): void {
  if (!hasSessionDisplayTable(db)) { return; }
  db.prepare(`DELETE FROM ${SESSION_DISPLAY_TABLE} WHERE session_id = ?`).run(sessionId);
}
