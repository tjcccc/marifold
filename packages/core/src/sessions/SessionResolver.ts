import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ImageInput, SQLiteSessionStore } from '@priest-ai/core';
import { SessionDetail, SessionSummary, SessionTurnSummary } from '../config/ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';

const ATTACHMENTS_TABLE = 'marifold_turn_attachments';
const SESSION_DISPLAY_TABLE = 'marifold_session_display';
const PROFILE_DISPLAY_TABLE = 'marifold_profile_display';
const DEFAULT_IMAGE_MEDIA_TYPE = 'image/jpeg';
const COMPACTION_METADATA_KEY = '__compaction';
const SESSION_TITLE_MAX_CHARS = 200;

export interface SessionDisplayUpdate {
  /** `null` clears a custom title and restores the first-message preview. */
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export interface SessionListOptions {
  /** Default is active sessions only. */
  archived?: boolean;
  /** Case-insensitive search across custom titles and first-message previews. */
  search?: string;
}

/** Result of a session-DB integrity check (used by `marifold doctor`). */
export interface SessionDbHealth {
  ok: boolean;
  /** False when the DB file does not exist yet (fresh install — not an error). */
  exists: boolean;
  /** First integrity-check failures, or the open error, when not ok. */
  error?: string;
  sessions?: number;
  turns?: number;
}

export interface SessionTruncateResult {
  found: boolean;
  removedTurns: number;
}

export interface SessionReplaceResult {
  found: boolean;
  replaced: boolean;
}

export interface ProfileActivitySummary {
  profileName: string;
  pinned?: boolean;
  updatedAt?: string;
  preview?: string;
}

export class SessionResolver {
  private store?: SQLiteSessionStore;

  constructor(private readonly sessionsDb: string) {}

  /** Open a connection with crash-resilience pragmas. `journal_mode = WAL` is a
   * persistent file property — set by any connection it sticks and is inherited
   * by every later opener (including priest's session store), making interrupted
   * writes far less likely to corrupt the file. `synchronous` and `busy_timeout`
   * are per-connection, so they are reapplied on every open. */
  private open(): Database.Database {
    const db = new Database(this.sessionsDb, { fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    return db;
  }

  /** Read-only health check. Safe to run when the DB is corrupt (it is the whole
   * point — `marifold doctor` must work when the app won't start), and never
   * throws: failures are returned as `{ ok: false }`. Opens read/write like the
   * app does, so a pass means the app can actually read the DB. */
  checkIntegrity(): SessionDbHealth {
    if (!fs.existsSync(this.sessionsDb)) return { ok: true, exists: false };
    let db: Database.Database;
    try {
      db = new Database(this.sessionsDb, { fileMustExist: true });
    } catch (error) {
      return { ok: false, exists: true, error: `cannot open: ${String(error)}` };
    }
    try {
      const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const results = rows.map(row => row.integrity_check);
      if (results.length === 1 && results[0] === 'ok') {
        const sessions = (db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c;
        const turns = (db.prepare('SELECT count(*) AS c FROM turns').get() as { c: number }).c;
        return { ok: true, exists: true, sessions, turns };
      }
      return { ok: false, exists: true, error: results.slice(0, 3).join('; ') };
    } catch (error) {
      return { ok: false, exists: true, error: String(error) };
    } finally {
      db.close();
    }
  }

  openStore(): SQLiteSessionStore {
    if (!this.store) {
      fs.mkdirSync(path.dirname(this.sessionsDb), { recursive: true });
      this.store = new SQLiteSessionStore(this.sessionsDb);
      this.store.open();
    }
    return this.store;
  }

  list(limit = 50, profileName?: string, options: SessionListOptions = {}): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDb)) return [];

    const db = this.open();
    try {
      this.ensureSessionDisplayTable(db);
      const search = options.search?.trim().toLowerCase() ?? '';
      const filters = [
        ...(profileName ? ['s.profile_name = ?'] : []),
        ['COALESCE(d.archived, 0) = ?'],
        ...(search ? [`(
          LOWER(COALESCE(d.title, '')) LIKE ?
          OR LOWER(COALESCE((
            SELECT content FROM turns
            WHERE session_id = s.id AND role = 'user'
            ORDER BY id ASC
            LIMIT 1
          ), '')) LIKE ?
        )`] : []),
      ].flat();
      const params: Array<string | number> = [
        ...(profileName ? [profileName] : []),
        options.archived ? 1 : 0,
        ...(search ? [`%${search}%`, `%${search}%`] : []),
        limit,
      ];
      const rows = db.prepare(`
        SELECT
          s.id AS id,
          s.profile_name AS profileName,
          s.created_at AS createdAt,
          s.updated_at AS updatedAt,
          d.title AS title,
          d.pinned AS pinned,
          d.archived AS archived,
          COUNT(t.id) AS turnCount,
          (
            SELECT content FROM turns
            WHERE session_id = s.id AND role = 'user'
            ORDER BY id ASC
            LIMIT 1
          ) AS preview
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        LEFT JOIN ${SESSION_DISPLAY_TABLE} d ON d.session_id = s.id
        WHERE ${filters.join(' AND ')}
        GROUP BY s.id
        ORDER BY
          COALESCE(d.pinned, 0) DESC,
          s.updated_at DESC
        LIMIT ?
      `).all(...params) as Array<{
        id: string;
        profileName: string;
        createdAt: string;
        updatedAt: string;
        title: string | null;
        pinned: number;
        archived: number;
        turnCount: number;
        preview: string | null;
      }>;
      return rows.map(row => {
        const preview = row.preview ? sessionPreview(row.preview) : '';
        return {
          id: row.id,
          profileName: row.profileName,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          turnCount: Number(row.turnCount),
          ...(preview ? { preview } : {}),
          ...(row.title ? { title: row.title } : {}),
          ...(row.pinned === 1 ? { pinned: true } : {}),
          ...(row.archived === 1 ? { archived: true } : {}),
        };
      });
    } catch (error) {
      throw new MarifoldError(
        'SESSION_STORE_ERROR',
        `Could not list sessions from ${this.sessionsDb}: ${String(error)}`,
        { sessionsDb: this.sessionsDb },
      );
    } finally {
      db.close();
    }
  }

  /** Contact-list metadata for every profile represented either by a session
   * or a pinned display row. The latest session determines activity/preview. */
  profileActivity(): ProfileActivitySummary[] {
    if (!fs.existsSync(this.sessionsDb)) return [];

    const db = this.open();
    try {
      this.ensureProfileDisplayTable(db);
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
          WHERE latest.profile_name = p.profile_name
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
          WHERE latest.profile_name = s.profile_name
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
    } catch (error) {
      throw this.storeError(`Could not list profile activity from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  setProfilePinned(profileName: string, pinned: boolean): void {
    if (!fs.existsSync(this.sessionsDb)) this.openStore();
    const db = this.open();
    try {
      this.ensureProfileDisplayTable(db);
      db.prepare(`
        INSERT INTO ${PROFILE_DISPLAY_TABLE} (profile_name, pinned)
        VALUES (?, ?)
        ON CONFLICT(profile_name) DO UPDATE SET pinned = excluded.pinned
      `).run(profileName, pinned ? 1 : 0);
    } catch (error) {
      throw this.storeError(`Could not update profile '${profileName}' display state: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  deleteProfileDisplay(profileName: string): void {
    if (!fs.existsSync(this.sessionsDb)) return;
    const db = this.open();
    try {
      if (this.hasProfileDisplayTable(db)) {
        db.prepare(`DELETE FROM ${PROFILE_DISPLAY_TABLE} WHERE profile_name = ?`).run(profileName);
      }
    } catch (error) {
      throw this.storeError(`Could not remove profile '${profileName}' display state: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  latest(profileName?: string): SessionSummary | undefined {
    if (!fs.existsSync(this.sessionsDb)) return undefined;
    const db = this.open();
    let id: string | undefined;
    try {
      const row = db.prepare(`
        SELECT id
        FROM sessions
        ${profileName ? 'WHERE profile_name = ?' : ''}
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(...(profileName ? [profileName] : [])) as { id: string } | undefined;
      id = row?.id;
    } catch (error) {
      throw this.storeError(`Could not find the latest session in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
    // Pinning only affects list presentation. Resume-last must continue to use
    // actual conversation recency.
    return id ? this.get(id) : undefined;
  }

  get(sessionId: string): SessionDetail | undefined {
    if (!fs.existsSync(this.sessionsDb)) return undefined;

    const db = this.open();
    try {
      this.ensureSessionDisplayTable(db);
      const row = db.prepare(`
        SELECT
          s.id AS id,
          s.profile_name AS profileName,
          s.created_at AS createdAt,
          s.updated_at AS updatedAt,
          d.title AS title,
          d.pinned AS pinned,
          d.archived AS archived,
          COUNT(t.id) AS turnCount,
          (
            SELECT content FROM turns
            WHERE session_id = s.id AND role = 'user'
            ORDER BY id ASC
            LIMIT 1
          ) AS preview
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        LEFT JOIN ${SESSION_DISPLAY_TABLE} d ON d.session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `).get(sessionId) as {
        id: string;
        profileName: string;
        createdAt: string;
        updatedAt: string;
        title: string | null;
        pinned: number;
        archived: number;
        turnCount: number;
        preview: string | null;
      } | undefined;
      if (!row) return undefined;

      const preview = row.preview ? sessionPreview(row.preview) : '';
      return {
        id: row.id,
        profileName: row.profileName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: Number(row.turnCount),
        ...(preview ? { preview } : {}),
        ...(row.title ? { title: row.title } : {}),
        ...(row.pinned === 1 ? { pinned: true } : {}),
        ...(row.archived === 1 ? { archived: true } : {}),
        turns: this.listTurns(db, row.id),
      };
    } catch (error) {
      throw this.storeError(`Could not read session '${sessionId}' from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  /** Read one persisted image without including its bytes in the session
   * transcript payload. The service exposes this through an authenticated
   * binary route so clients can fetch only visible/previewed images. */
  getAttachment(
    sessionId: string,
    userTurnIndex: number,
    attachmentIndex: number,
  ): { mediaType: string; data?: string; url?: string } | undefined {
    if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0
      || !Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
      throw MarifoldError.configInvalid('Attachment coordinates must be non-negative integers.');
    }
    if (!fs.existsSync(this.sessionsDb)) return undefined;
    const db = this.open();
    try {
      if (!this.hasAttachmentsTable(db)) return undefined;
      const row = db.prepare(`
        SELECT media_type AS mediaType, data, url
        FROM ${ATTACHMENTS_TABLE}
        WHERE session_id = ? AND user_turn_index = ? AND attachment_index = ?
      `).get(sessionId, userTurnIndex, attachmentIndex) as {
        mediaType: string;
        data: string | null;
        url: string | null;
      } | undefined;
      if (!row) return undefined;
      return {
        mediaType: row.mediaType,
        ...(row.data !== null ? { data: row.data } : {}),
        ...(row.url !== null ? { url: row.url } : {}),
      };
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not read an attachment for session '${sessionId}' from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  delete(sessionId: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;

    const db = this.open();
    try {
      const transaction = db.transaction(() => {
        this.deleteAttachmentsForSession(db, sessionId);
        this.deleteDisplayForSession(db, sessionId);
        db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
        return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes;
      });
      return transaction() > 0;
    } catch (error) {
      throw this.storeError(`Could not delete session '${sessionId}' from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  /** Update sidebar-only session fields without touching ids, turns, recency,
   * or Priest's metadata column. A separate table prevents a model save that
   * finishes later from overwriting a rename/pin made during the run. */
  updateDisplay(sessionId: string, update: SessionDisplayUpdate): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;
    if (update.title === undefined && update.pinned === undefined && update.archived === undefined) {
      throw MarifoldError.configInvalid('At least one of title, pinned, or archived is required.');
    }
    const title = update.title === null ? null : update.title?.trim();
    if (title !== undefined && title !== null && title.length === 0) {
      throw MarifoldError.configInvalid('Session title cannot be empty.');
    }
    if (title !== undefined && title !== null && title.length > SESSION_TITLE_MAX_CHARS) {
      throw MarifoldError.configInvalid(`Session title cannot exceed ${SESSION_TITLE_MAX_CHARS} characters.`);
    }

    const db = this.open();
    try {
      if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) return false;
      this.ensureSessionDisplayTable(db);
      const current = db.prepare(`
        SELECT title, pinned, archived
        FROM ${SESSION_DISPLAY_TABLE}
        WHERE session_id = ?
      `).get(sessionId) as { title: string | null; pinned: number; archived: number } | undefined;
      const nextTitle = title === undefined ? current?.title ?? null : title;
      const nextPinned = update.pinned === undefined ? current?.pinned === 1 : update.pinned;
      const nextArchived = update.archived === undefined ? current?.archived === 1 : update.archived;
      if (nextTitle === null && !nextPinned && !nextArchived) {
        db.prepare(`DELETE FROM ${SESSION_DISPLAY_TABLE} WHERE session_id = ?`).run(sessionId);
      } else {
        db.prepare(`
          INSERT INTO ${SESSION_DISPLAY_TABLE} (session_id, title, pinned, archived)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            title = excluded.title,
            pinned = excluded.pinned,
            archived = excluded.archived
        `).run(sessionId, nextTitle, nextPinned ? 1 : 0, nextArchived ? 1 : 0);
      }
      return true;
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not update session '${sessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  /** Delete one user turn and the entire conversation branch after it. The
   * ordinal is zero-based among user turns, so it remains stable even though
   * Priest rewrites SQLite turn ids whenever a session is saved. */
  truncateFromUserTurn(sessionId: string, userTurnIndex: number): SessionTruncateResult {
    if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
      throw MarifoldError.configInvalid('userTurnIndex must be a non-negative integer.');
    }
    if (!fs.existsSync(this.sessionsDb)) return { found: false, removedTurns: 0 };

    const db = this.open();
    try {
      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
      if (!session) return { found: false, removedTurns: 0 };
      const target = db.prepare(`
        SELECT id
        FROM turns
        WHERE session_id = ? AND role = 'user'
        ORDER BY id ASC
        LIMIT 1 OFFSET ?
      `).get(sessionId, userTurnIndex) as { id: number } | undefined;

      const transaction = db.transaction(() => {
        if (this.hasAttachmentsTable(db)) {
          db.prepare(`
            DELETE FROM ${ATTACHMENTS_TABLE}
            WHERE session_id = ? AND user_turn_index >= ?
          `).run(sessionId, userTurnIndex);
        }
        if (!target) return 0;
        const removedTurns = db.prepare(`
          DELETE FROM turns
          WHERE session_id = ? AND id >= ?
        `).run(sessionId, target.id).changes;
        if (removedTurns > 0) {
          db.prepare(`
            UPDATE sessions
            SET updated_at = strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')
            WHERE id = ?
          `).run(sessionId);
        }
        return removedTurns;
      });
      return { found: true, removedTurns: transaction() };
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not truncate session '${sessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  /** Return only the completed turns before a zero-based user-turn ordinal.
   * Historical edits use this as model context so later exchanges cannot leak
   * into the regenerated answer. `undefined` means the session/turn is absent. */
  turnsBeforeUserTurn(sessionId: string, userTurnIndex: number): SessionTurnSummary[] | undefined {
    if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
      throw MarifoldError.configInvalid('userTurnIndex must be a non-negative integer.');
    }
    const detail = this.get(sessionId);
    if (!detail) return undefined;
    const before: SessionTurnSummary[] = [];
    let currentUserIndex = 0;
    for (const turn of detail.turns) {
      if (turn.role === 'user') {
        if (currentUserIndex === userTurnIndex) return before;
        currentUserIndex += 1;
      }
      before.push(turn);
    }
    return undefined;
  }

  /** Replace one persisted user→assistant exchange in place. Later exchanges
   * keep their ids/order and therefore remain visible and available as future
   * model context. Attachments are replaced only when `images` is provided. */
  replaceExchange(
    sessionId: string,
    userTurnIndex: number,
    userText: string,
    assistantText: string,
    images?: ImageInput[],
  ): SessionReplaceResult {
    if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
      throw MarifoldError.configInvalid('userTurnIndex must be a non-negative integer.');
    }
    if (!fs.existsSync(this.sessionsDb)) return { found: false, replaced: false };

    const db = this.open();
    try {
      const session = db.prepare('SELECT id, metadata FROM sessions WHERE id = ?').get(sessionId) as {
        id: string;
        metadata: string;
      } | undefined;
      if (!session) return { found: false, replaced: false };
      const target = db.prepare(`
        SELECT id
        FROM turns
        WHERE session_id = ? AND role = 'user'
        ORDER BY id ASC
        LIMIT 1 OFFSET ?
      `).get(sessionId, userTurnIndex) as { id: number } | undefined;
      if (!target) return { found: true, replaced: false };
      const nextUser = db.prepare(`
        SELECT id
        FROM turns
        WHERE session_id = ? AND role = 'user' AND id > ?
        ORDER BY id ASC
        LIMIT 1
      `).get(sessionId, target.id) as { id: number } | undefined;
      const assistant = db.prepare(`
        SELECT id
        FROM turns
        WHERE session_id = ? AND role = 'assistant' AND id > ?
          ${nextUser ? 'AND id < ?' : ''}
        ORDER BY id ASC
        LIMIT 1
      `).get(...(nextUser
        ? [sessionId, target.id, nextUser.id]
        : [sessionId, target.id])) as { id: number } | undefined;
      if (!assistant) return { found: true, replaced: false };

      const transaction = db.transaction(() => {
        db.prepare('UPDATE turns SET content = ? WHERE id = ?').run(userText, target.id);
        db.prepare('UPDATE turns SET content = ? WHERE id = ?').run(assistantText, assistant.id);
        if (images !== undefined) this.replaceUserTurnAttachments(db, sessionId, userTurnIndex, images);
        const metadata = JSON.parse(session.metadata) as Record<string, unknown>;
        delete metadata[COMPACTION_METADATA_KEY];
        db.prepare(`
          UPDATE sessions
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now'),
              metadata = ?
          WHERE id = ?
        `).run(JSON.stringify(metadata), sessionId);
      });
      transaction();
      return { found: true, replaced: true };
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not replace exchange ${userTurnIndex} in session '${sessionId}': ${String(error)}`);
    } finally {
      db.close();
    }
  }

  clear(options: { profileName?: string; before?: string; keepLast?: number } = {}): { count: number; ids: string[] } {
    if (!fs.existsSync(this.sessionsDb)) return { count: 0, ids: [] };
    const keepLast = options.keepLast ?? 0;
    if (!Number.isInteger(keepLast) || keepLast < 0) {
      throw MarifoldError.configInvalid('keepLast must be a non-negative integer.');
    }

    const db = this.open();
    try {
      const where: string[] = [];
      const params: string[] = [];
      if (options.profileName) {
        where.push('profile_name = ?');
        params.push(options.profileName);
      }
      if (options.before) {
        where.push('updated_at < ?');
        params.push(options.before);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT id
        FROM sessions
        ${whereSql}
        ORDER BY updated_at DESC
      `).all(...params) as Array<{ id: string }>;

      const ids = rows.map(row => row.id).slice(keepLast);
      if (ids.length === 0) return { count: 0, ids: [] };

      const transaction = db.transaction((sessionIds: string[]) => {
        const deleteTurns = db.prepare('DELETE FROM turns WHERE session_id = ?');
        const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
        for (const id of sessionIds) {
          this.deleteAttachmentsForSession(db, id);
          this.deleteDisplayForSession(db, id);
          deleteTurns.run(id);
          deleteSession.run(id);
        }
      });
      transaction(ids);
      return { count: ids.length, ids };
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not clear sessions from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  replaceLastAssistantTurn(sessionId: string, content: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;

    const db = this.open();
    try {
      const result = db.prepare(`
        UPDATE turns
        SET content = ?
        WHERE id = (
          SELECT id
          FROM turns
          WHERE session_id = ? AND role = 'assistant'
          ORDER BY id DESC
          LIMIT 1
        )
      `).run(content, sessionId);
      return result.changes > 0;
    } catch (error) {
      throw this.storeError(`Could not clean session '${sessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  replaceLastUserTurn(sessionId: string, content: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;

    const db = this.open();
    try {
      const result = db.prepare(`
        UPDATE turns
        SET content = ?
        WHERE id = (
          SELECT id
          FROM turns
          WHERE session_id = ? AND role = 'user'
          ORDER BY id DESC
          LIMIT 1
        )
      `).run(content, sessionId);
      return result.changes > 0;
    } catch (error) {
      throw this.storeError(`Could not clean session '${sessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  /** Append one clean user→assistant exchange to a session (creating it if
   * needed). Agent runs use this to record the objective + final answer as a
   * single tidy pair, instead of priest's raw per-iteration `Objective:`/tool
   * framing that made resumed transcripts confusing. */
  async appendExchange(
    sessionId: string,
    profileName: string,
    userText: string,
    assistantText: string,
    images?: ImageInput[],
  ): Promise<void> {
    const store = this.openStore();
    const session = (await store.get(sessionId)) ?? (await store.create(profileName, sessionId));
    session.appendTurn('user', userText);
    session.appendTurn('assistant', assistantText);
    await store.save(session);
    this.saveLastUserTurnAttachments(sessionId, images);
  }

  /** Persist display-only image sources against the newest user turn. Priest
   * intentionally stores text-only session history, so Marifold owns this
   * side table and keeps it out of later model context. Local filesystem paths
   * are deliberately skipped rather than exposed through the service API. */
  saveLastUserTurnAttachments(sessionId: string, images?: ImageInput[]): void {
    const persistable = (images ?? []).filter(
      (image): image is ImageInput & ({ data: string } | { url: string }) =>
        Boolean(image.data || image.url),
    );
    if (persistable.length === 0 || !fs.existsSync(this.sessionsDb)) return;

    const db = this.open();
    try {
      this.ensureAttachmentsTable(db);
      const userTurns = db.prepare(`
        SELECT COUNT(*) AS count
        FROM turns
        WHERE session_id = ? AND role = 'user'
      `).get(sessionId) as { count: number };
      if (userTurns.count === 0) return;

      const transaction = db.transaction(() => {
        // Priest rewrites the turns table on every session save, so SQLite
        // turn ids are not stable. The zero-based user-turn ordinal is.
        const userTurnIndex = userTurns.count - 1;
        db.prepare(`
          DELETE FROM ${ATTACHMENTS_TABLE}
          WHERE session_id = ? AND user_turn_index = ?
        `).run(sessionId, userTurnIndex);
        const insert = db.prepare(`
          INSERT INTO ${ATTACHMENTS_TABLE}
            (session_id, user_turn_index, attachment_index, media_type, data, url)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const [index, image] of persistable.entries()) {
          insert.run(
            sessionId,
            userTurnIndex,
            index,
            image.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE,
            image.data ?? null,
            image.url ?? null,
          );
        }
      });
      transaction();
    } catch (error) {
      throw this.storeError(`Could not save attachments for session '${sessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  rename(fromSessionId: string, toSessionId: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;
    if (!toSessionId.trim()) throw MarifoldError.configInvalid('New session id cannot be empty.');

    const db = this.open();
    try {
      const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(fromSessionId);
      if (!exists) return false;
      const conflict = db.prepare('SELECT id FROM sessions WHERE id = ?').get(toSessionId);
      if (conflict) {
        throw new MarifoldError(
          'SESSION_STORE_ERROR',
          `Session '${toSessionId}' already exists.`,
          { sessionsDb: this.sessionsDb },
        );
      }

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (id, profile_name, created_at, updated_at, metadata)
          SELECT ?, profile_name, created_at, updated_at, metadata
          FROM sessions
          WHERE id = ?
        `).run(toSessionId, fromSessionId);
        if (this.hasAttachmentsTable(db)) {
          db.prepare(`UPDATE ${ATTACHMENTS_TABLE} SET session_id = ? WHERE session_id = ?`)
            .run(toSessionId, fromSessionId);
        }
        if (this.hasSessionDisplayTable(db)) {
          db.prepare(`UPDATE ${SESSION_DISPLAY_TABLE} SET session_id = ? WHERE session_id = ?`)
            .run(toSessionId, fromSessionId);
        }
        db.prepare('UPDATE turns SET session_id = ? WHERE session_id = ?').run(toSessionId, fromSessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(fromSessionId);
      });
      transaction();
      return true;
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw this.storeError(`Could not rename session '${fromSessionId}' in ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  close(): void {
    this.store?.close();
    this.store = undefined;
  }

  private listTurns(db: Database.Database, sessionId: string): SessionTurnSummary[] {
    const rows = db.prepare(`
      SELECT role, content, timestamp
      FROM turns
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as SessionTurnSummary[];
    const attachments = this.listAttachments(db, sessionId);
    let userTurnIndex = 0;
    return rows.map(row => {
      const turnAttachments = row.role === 'user' ? attachments.get(userTurnIndex) : undefined;
      if (row.role === 'user') userTurnIndex += 1;
      return {
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        ...(turnAttachments ? { attachments: turnAttachments } : {}),
      };
    });
  }

  private ensureAttachmentsTable(db: Database.Database): void {
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
  }

  private hasAttachmentsTable(db: Database.Database): boolean {
    return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(ATTACHMENTS_TABLE) !== undefined;
  }

  private listAttachments(
    db: Database.Database,
    sessionId: string,
  ): Map<number, NonNullable<SessionTurnSummary['attachments']>> {
    const byTurn = new Map<number, NonNullable<SessionTurnSummary['attachments']>>();
    if (!this.hasAttachmentsTable(db)) return byTurn;
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

  private replaceUserTurnAttachments(
    db: Database.Database,
    sessionId: string,
    userTurnIndex: number,
    images: ImageInput[],
  ): void {
    const persistable = images.filter(
      (image): image is ImageInput & ({ data: string } | { url: string }) => Boolean(image.data || image.url),
    );
    if (persistable.length > 0) this.ensureAttachmentsTable(db);
    if (!this.hasAttachmentsTable(db)) return;
    db.prepare(`
      DELETE FROM ${ATTACHMENTS_TABLE}
      WHERE session_id = ? AND user_turn_index = ?
    `).run(sessionId, userTurnIndex);
    if (persistable.length === 0) return;
    const insert = db.prepare(`
      INSERT INTO ${ATTACHMENTS_TABLE}
        (session_id, user_turn_index, attachment_index, media_type, data, url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [index, image] of persistable.entries()) {
      insert.run(
        sessionId,
        userTurnIndex,
        index,
        image.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE,
        image.data ?? null,
        image.url ?? null,
      );
    }
  }

  private deleteAttachmentsForSession(db: Database.Database, sessionId: string): void {
    if (!this.hasAttachmentsTable(db)) return;
    db.prepare(`DELETE FROM ${ATTACHMENTS_TABLE} WHERE session_id = ?`).run(sessionId);
  }

  private ensureSessionDisplayTable(db: Database.Database): void {
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

  private ensureProfileDisplayTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${PROFILE_DISPLAY_TABLE} (
        profile_name TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
      )
    `);
  }

  private hasProfileDisplayTable(db: Database.Database): boolean {
    return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(PROFILE_DISPLAY_TABLE) !== undefined;
  }

  private hasSessionDisplayTable(db: Database.Database): boolean {
    return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(SESSION_DISPLAY_TABLE) !== undefined;
  }

  private deleteDisplayForSession(db: Database.Database, sessionId: string): void {
    if (!this.hasSessionDisplayTable(db)) return;
    db.prepare(`DELETE FROM ${SESSION_DISPLAY_TABLE} WHERE session_id = ?`).run(sessionId);
  }

  private storeError(message: string): MarifoldError {
    return new MarifoldError('SESSION_STORE_ERROR', message, { sessionsDb: this.sessionsDb });
  }
}

const PREVIEW_MAX_CHARS = 80;

function sessionPreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return `${flat.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function firstLinePreview(content: string): string {
  const first = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '') ?? '';
  if (first.length <= PREVIEW_MAX_CHARS) return first;
  return `${first.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}
