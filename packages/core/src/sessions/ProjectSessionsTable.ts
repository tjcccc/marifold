import type Database from 'better-sqlite3';

/** Which project a session belongs to, and its floor: the profile that answers
 * a message that addresses no one. Sessions without a row are ordinary
 * profile sessions. Lives beside Priest's tables in the sessions database. */
export const PROJECT_SESSIONS_TABLE = 'marifold_project_sessions';

export function ensureProjectSessionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECT_SESSIONS_TABLE} (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      floor TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS ${PROJECT_SESSIONS_TABLE}_project ON ${PROJECT_SESSIONS_TABLE} (project_id)`);
}

/** SQL condition on a `sessions` alias: the session belongs to no project
 * (no `projectId`), or to the given one. Bind `projectId` when given. */
export function projectSessionFilter(alias: string, projectId?: string): string {
  const linked = `SELECT 1 FROM ${PROJECT_SESSIONS_TABLE} ps WHERE ps.session_id = ${alias}.id`;
  return projectId === undefined ? `NOT EXISTS (${linked})` : `EXISTS (${linked} AND ps.project_id = ?)`;
}

/** Keep a renamed session in its project. */
export function renameProjectLink(db: Database.Database, from: string, to: string): void {
  ensureProjectSessionsTable(db);
  db.prepare(`UPDATE ${PROJECT_SESSIONS_TABLE} SET session_id = ? WHERE session_id = ?`).run(to, from);
}

export function deleteProjectLinkForSession(db: Database.Database, sessionId: string): void {
  ensureProjectSessionsTable(db);
  db.prepare(`DELETE FROM ${PROJECT_SESSIONS_TABLE} WHERE session_id = ?`).run(sessionId);
}
