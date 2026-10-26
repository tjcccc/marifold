import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';
import { ensureProjectSessionsTable, PROJECT_SESSIONS_TABLE } from '../sessions/ProjectSessionsTable';

/**
 * Projects: shared places for ongoing work, kept in the sessions database next
 * to the sessions they hold (see docs/projects.md). A project has a roster of
 * invited profiles and a Lead, always on the roster, that answers when no one
 * is addressed. Sessions keep Priest's `profile_name`; membership in a project
 * is a row in `marifold_project_sessions`.
 */

export const PROJECTS_TABLE = 'marifold_projects';
export const PROJECT_MEMBERS_TABLE = 'marifold_project_members';

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const INSTRUCTIONS_MAX = 50_000;

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  lead: string;
  /** Roster in join order; always contains the Lead. */
  members: string[];
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  instructions: string;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
  instructions?: string;
  lead: string;
  /** Invited besides the Lead. */
  members?: string[];
}

export interface ProjectUpdate {
  name?: string;
  /** `null` clears it. */
  description?: string | null;
  instructions?: string;
  /** Joins the roster when not on it yet. */
  lead?: string;
}

export interface SessionProject {
  projectId: string;
  /** The profile that answers a message addressing no one; the Lead when unset. */
  floor?: string;
}

export function ensureProjectTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECTS_TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT NOT NULL DEFAULT '',
      lead TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${PROJECT_MEMBERS_TABLE} (
      project_id TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, profile_name)
    );
  `);
  ensureProjectSessionsTable(db);
}

/** Rename a profile in every roster, Lead and floor. Runs inside the caller's
 * transaction (profile rename moves sessions and projects together). */
export function renameProjectProfile(db: Database.Database, from: string, to: string): void {
  ensureProjectTables(db);
  db.prepare(`DELETE FROM ${PROJECT_MEMBERS_TABLE} WHERE profile_name = ? AND project_id IN (SELECT project_id FROM ${PROJECT_MEMBERS_TABLE} WHERE profile_name = ?)`).run(from, to);
  db.prepare(`UPDATE ${PROJECT_MEMBERS_TABLE} SET profile_name = ? WHERE profile_name = ?`).run(to, from);
  db.prepare(`UPDATE ${PROJECTS_TABLE} SET lead = ? WHERE lead = ?`).run(to, from);
  db.prepare(`UPDATE ${PROJECT_SESSIONS_TABLE} SET floor = ? WHERE floor = ?`).run(to, from);
}

export class ProjectStore {
  constructor(
    private readonly sessionsDb: string,
    /** Profiles must exist to be invited or lead; unchecked when omitted. */
    private readonly profileExists?: (name: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): ProjectSummary[] {
    return this.read(db => (db.prepare(`SELECT * FROM ${PROJECTS_TABLE} ORDER BY name COLLATE NOCASE, id`).all() as ProjectRow[])
      .map(row => summary(db, row)));
  }

  get(id: string): ProjectDetail | undefined {
    return this.read(db => {
      const row = projectRow(db, id);
      return row ? { ...summary(db, row), instructions: row.instructions } : undefined;
    });
  }

  create(input: ProjectCreateInput): ProjectDetail {
    const name = this.validName(input.name);
    const lead = this.validProfile(input.lead);
    const members = [...new Set([lead, ...(input.members ?? []).map(member => this.validProfile(member))])];
    const id = `proj_${crypto.randomBytes(6).toString('hex')}`;
    this.write(db => {
      this.assertNameFree(db, name);
      const at = this.now().toISOString();
      db.prepare(`INSERT INTO ${PROJECTS_TABLE} (id, name, description, instructions, lead, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, validDescription(input.description) ?? null, validInstructions(input.instructions ?? ''), lead, at, at);
      for (const member of members) { addMember(db, id, member, at); }
    });
    return this.get(id)!;
  }

  update(id: string, patch: ProjectUpdate): ProjectDetail {
    const name = patch.name === undefined ? undefined : this.validName(patch.name);
    const lead = patch.lead === undefined ? undefined : this.validProfile(patch.lead);
    this.write(db => {
      this.existing(db, id);
      const at = this.now().toISOString();
      if (name !== undefined) { this.assertNameFree(db, name, id); db.prepare(`UPDATE ${PROJECTS_TABLE} SET name = ? WHERE id = ?`).run(name, id); }
      if (patch.description !== undefined) {
        db.prepare(`UPDATE ${PROJECTS_TABLE} SET description = ? WHERE id = ?`).run(patch.description === null ? null : validDescription(patch.description) ?? null, id);
      }
      if (patch.instructions !== undefined) { db.prepare(`UPDATE ${PROJECTS_TABLE} SET instructions = ? WHERE id = ?`).run(validInstructions(patch.instructions), id); }
      if (lead !== undefined) {
        addMember(db, id, lead, at);
        db.prepare(`UPDATE ${PROJECTS_TABLE} SET lead = ? WHERE id = ?`).run(lead, id);
      }
      touch(db, id, at);
    });
    return this.get(id)!;
  }

  /** Delete a project. Its sessions are kept and become ordinary sessions of
   * the profile each was started with; returns how many. */
  delete(id: string): { sessions: number } {
    return this.write(db => {
      this.existing(db, id);
      const sessions = db.prepare(`DELETE FROM ${PROJECT_SESSIONS_TABLE} WHERE project_id = ?`).run(id).changes;
      db.prepare(`DELETE FROM ${PROJECT_MEMBERS_TABLE} WHERE project_id = ?`).run(id);
      db.prepare(`DELETE FROM ${PROJECTS_TABLE} WHERE id = ?`).run(id);
      return { sessions };
    });
  }

  invite(id: string, profile: string): ProjectDetail {
    const name = this.validProfile(profile);
    this.write(db => {
      this.existing(db, id);
      const at = this.now().toISOString();
      addMember(db, id, name, at);
      touch(db, id, at);
    });
    return this.get(id)!;
  }

  /** Remove a profile from the roster. Its replies stay in the transcript;
   * sessions whose floor it held return to the Lead. The Lead cannot leave. */
  dismiss(id: string, profile: string): ProjectDetail {
    this.write(db => {
      const project = this.existing(db, id);
      if (project.lead === profile) {
        throw MarifoldError.projectInvalid(`'${profile}' leads this project; choose another Lead before dismissing it.`, id);
      }
      if (db.prepare(`DELETE FROM ${PROJECT_MEMBERS_TABLE} WHERE project_id = ? AND profile_name = ?`).run(id, profile).changes === 0) {
        throw MarifoldError.projectInvalid(`'${profile}' is not on this project's roster.`, id);
      }
      db.prepare(`UPDATE ${PROJECT_SESSIONS_TABLE} SET floor = NULL WHERE project_id = ? AND floor = ?`).run(id, profile);
      touch(db, id, this.now().toISOString());
    });
    return this.get(id)!;
  }

  /**
   * Move a session into a project (`projectId`) or out of any (`null`). Its
   * profile joins the roster and keeps answering until someone else is
   * addressed; a deleted profile's session goes to the Lead instead. Moving
   * out makes it an ordinary session of that profile again.
   */
  moveSession(sessionId: string, projectId: string | null): SessionProject | undefined {
    return this.write(db => {
      const hasSessions = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get();
      const session = hasSessions
        ? db.prepare('SELECT profile_name AS profile FROM sessions WHERE id = ?').get(sessionId) as { profile: string | null } | undefined
        : undefined;
      if (!session) { throw MarifoldError.projectInvalid(`Session not found: ${sessionId}`); }
      if (projectId === null) {
        db.prepare(`DELETE FROM ${PROJECT_SESSIONS_TABLE} WHERE session_id = ?`).run(sessionId);
        return undefined;
      }
      this.existing(db, projectId);
      const at = this.now().toISOString();
      const floor = session.profile && this.profileAvailable(session.profile) ? session.profile : undefined;
      if (floor) { addMember(db, projectId, floor, at); }
      db.prepare(`INSERT INTO ${PROJECT_SESSIONS_TABLE} (session_id, project_id, floor) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, floor = excluded.floor`).run(sessionId, projectId, floor ?? null);
      touch(db, projectId, at);
      return { projectId, ...(floor ? { floor } : {}) };
    });
  }

  sessionProject(sessionId: string): SessionProject | undefined {
    return this.read(db => {
      const row = db.prepare(`SELECT project_id AS projectId, floor FROM ${PROJECT_SESSIONS_TABLE} WHERE session_id = ?`).get(sessionId) as { projectId: string; floor: string | null } | undefined;
      return row ? { projectId: row.projectId, ...(row.floor ? { floor: row.floor } : {}) } : undefined;
    });
  }

  /** Hand a project session's floor to a roster profile, or back to the Lead. */
  setFloor(sessionId: string, profile: string | undefined): void {
    this.write(db => {
      const link = db.prepare(`SELECT project_id AS projectId FROM ${PROJECT_SESSIONS_TABLE} WHERE session_id = ?`).get(sessionId) as { projectId: string } | undefined;
      if (!link) { throw MarifoldError.projectInvalid(`Session ${sessionId} is not in a project.`); }
      if (profile !== undefined && !isMember(db, link.projectId, profile)) {
        throw MarifoldError.projectInvalid(`'${profile}' is not on this project's roster.`, link.projectId);
      }
      db.prepare(`UPDATE ${PROJECT_SESSIONS_TABLE} SET floor = ? WHERE session_id = ?`).run(profile ?? null, sessionId);
    });
  }

  /** Names of the projects a profile leads. */
  ledBy(profile: string): string[] {
    return this.read(db => (db.prepare(`SELECT name FROM ${PROJECTS_TABLE} WHERE lead = ? ORDER BY name COLLATE NOCASE`).all(profile) as Array<{ name: string }>).map(row => row.name));
  }

  /** A deleted profile leaves every roster and floor (it leads none: see `ledBy`). */
  removeProfile(profile: string): void {
    this.write(db => {
      db.prepare(`DELETE FROM ${PROJECT_MEMBERS_TABLE} WHERE profile_name = ?`).run(profile);
      db.prepare(`UPDATE ${PROJECT_SESSIONS_TABLE} SET floor = NULL WHERE floor = ?`).run(profile);
    });
  }

  private existing(db: Database.Database, id: string): ProjectRow {
    const row = projectRow(db, id);
    if (!row) { throw MarifoldError.projectNotFound(id); }
    return row;
  }

  private validName(value: string): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > NAME_MAX || /[\p{Cc}]/u.test(name)) {
      throw MarifoldError.projectInvalid(`A project name is 1–${NAME_MAX} characters on one line.`);
    }
    return name;
  }

  private assertNameFree(db: Database.Database, name: string, except?: string): void {
    const taken = db.prepare(`SELECT id FROM ${PROJECTS_TABLE} WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, except ?? '');
    if (taken) { throw MarifoldError.projectInvalid(`A project named '${name}' already exists.`); }
  }

  private validProfile(name: string): string {
    if (!this.profileAvailable(name)) { throw MarifoldError.projectInvalid(`Profile not found: ${name}`); }
    return name;
  }

  private profileAvailable(name: string): boolean {
    if (typeof name !== 'string' || name.trim() === '') { return false; }
    try { return this.profileExists?.(name) ?? true; } catch { return false; }
  }

  private read<T>(work: (db: Database.Database) => T): T {
    if (fs.existsSync(this.sessionsDb)) { return this.write(work); }
    // Before the sessions database exists there are no projects.
    const db = new Database(':memory:');
    try {
      ensureProjectTables(db);
      return work(db);
    } finally {
      db.close();
    }
  }

  private write<T>(work: (db: Database.Database) => T): T {
    fs.mkdirSync(path.dirname(this.sessionsDb), { recursive: true });
    const db = new Database(this.sessionsDb);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      ensureProjectTables(db);
      return db.transaction(() => work(db))();
    } finally {
      db.close();
    }
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  lead: string;
  created_at: string;
  updated_at: string;
}

function projectRow(db: Database.Database, id: string): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM ${PROJECTS_TABLE} WHERE id = ?`).get(id) as ProjectRow | undefined;
}

function summary(db: Database.Database, row: ProjectRow): ProjectSummary {
  const members = (db.prepare(`SELECT profile_name AS name FROM ${PROJECT_MEMBERS_TABLE} WHERE project_id = ? ORDER BY joined_at, rowid`).all(row.id) as Array<{ name: string }>).map(member => member.name);
  const sessions = db.prepare(`SELECT COUNT(*) AS count FROM ${PROJECT_SESSIONS_TABLE} WHERE project_id = ?`).get(row.id) as { count: number };
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    lead: row.lead,
    members,
    sessionCount: sessions.count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMember(db: Database.Database, projectId: string, profile: string): boolean {
  return db.prepare(`SELECT 1 FROM ${PROJECT_MEMBERS_TABLE} WHERE project_id = ? AND profile_name = ?`).get(projectId, profile) !== undefined;
}

function addMember(db: Database.Database, projectId: string, profile: string, at: string): void {
  db.prepare(`INSERT OR IGNORE INTO ${PROJECT_MEMBERS_TABLE} (project_id, profile_name, joined_at) VALUES (?, ?, ?)`).run(projectId, profile, at);
}

function touch(db: Database.Database, id: string, at: string): void {
  db.prepare(`UPDATE ${PROJECTS_TABLE} SET updated_at = ? WHERE id = ?`).run(at, id);
}

function validDescription(value: string | undefined): string | undefined {
  if (value === undefined) { return undefined; }
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length > DESCRIPTION_MAX) { throw MarifoldError.projectInvalid(`A project description is at most ${DESCRIPTION_MAX} characters.`); }
  return description || undefined;
}

function validInstructions(value: string): string {
  if (typeof value !== 'string' || value.length > INSTRUCTIONS_MAX) {
    throw MarifoldError.projectInvalid(`Project instructions are at most ${INSTRUCTIONS_MAX} characters.`);
  }
  return value;
}
