import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SQLiteSessionStore } from '@priest-ai/core';
import { SessionDetail, SessionSummary, SessionTurnSummary } from '../config/ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';

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

  list(limit = 50, profileName?: string): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDb)) return [];

    const db = this.open();
    try {
      const rows = db.prepare(`
        SELECT
          s.id AS id,
          s.profile_name AS profileName,
          s.created_at AS createdAt,
          s.updated_at AS updatedAt,
          COUNT(t.id) AS turnCount
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        ${profileName ? 'WHERE s.profile_name = ?' : ''}
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?
      `).all(...(profileName ? [profileName, limit] : [limit])) as Array<{
        id: string;
        profileName: string;
        createdAt: string;
        updatedAt: string;
        turnCount: number;
      }>;
      return rows.map(row => ({
        id: row.id,
        profileName: row.profileName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: Number(row.turnCount),
      }));
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

  latest(profileName?: string): SessionSummary | undefined {
    return this.list(1, profileName)[0];
  }

  get(sessionId: string): SessionDetail | undefined {
    if (!fs.existsSync(this.sessionsDb)) return undefined;

    const db = this.open();
    try {
      const row = db.prepare(`
        SELECT
          s.id AS id,
          s.profile_name AS profileName,
          s.created_at AS createdAt,
          s.updated_at AS updatedAt,
          COUNT(t.id) AS turnCount
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `).get(sessionId) as {
        id: string;
        profileName: string;
        createdAt: string;
        updatedAt: string;
        turnCount: number;
      } | undefined;
      if (!row) return undefined;

      return {
        id: row.id,
        profileName: row.profileName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: Number(row.turnCount),
        turns: this.listTurns(db, row.id),
      };
    } catch (error) {
      throw this.storeError(`Could not read session '${sessionId}' from ${this.sessionsDb}: ${String(error)}`);
    } finally {
      db.close();
    }
  }

  delete(sessionId: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;

    const db = this.open();
    try {
      const transaction = db.transaction(() => {
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

  /** Append one clean user→assistant exchange to a session (creating it if
   * needed). Agent runs use this to record the objective + final answer as a
   * single tidy pair, instead of priest's raw per-iteration `Objective:`/tool
   * framing that made resumed transcripts confusing. */
  async appendExchange(sessionId: string, profileName: string, userText: string, assistantText: string): Promise<void> {
    const store = this.openStore();
    const session = (await store.get(sessionId)) ?? (await store.create(profileName, sessionId));
    session.appendTurn('user', userText);
    session.appendTurn('assistant', assistantText);
    await store.save(session);
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
    return rows.map(row => ({
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    }));
  }

  private storeError(message: string): MarifoldError {
    return new MarifoldError('SESSION_STORE_ERROR', message, { sessionsDb: this.sessionsDb });
  }
}
