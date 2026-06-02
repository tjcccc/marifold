import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SQLiteSessionStore } from '@priest-ai/core';
import { SessionDetail, SessionSummary, SessionTurnSummary } from '../config/ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';

export class SessionResolver {
  private store?: SQLiteSessionStore;

  constructor(private readonly sessionsDb: string) {}

  openStore(): SQLiteSessionStore {
    if (!this.store) {
      fs.mkdirSync(path.dirname(this.sessionsDb), { recursive: true });
      this.store = new SQLiteSessionStore(this.sessionsDb);
      this.store.open();
    }
    return this.store;
  }

  list(limit = 50): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDb)) return [];

    const db = new Database(this.sessionsDb, { fileMustExist: true });
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
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?
      `).all(limit) as Array<{
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

  get(sessionId: string): SessionDetail | undefined {
    if (!fs.existsSync(this.sessionsDb)) return undefined;

    const db = new Database(this.sessionsDb, { fileMustExist: true });
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

    const db = new Database(this.sessionsDb, { fileMustExist: true });
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

  rename(fromSessionId: string, toSessionId: string): boolean {
    if (!fs.existsSync(this.sessionsDb)) return false;
    if (!toSessionId.trim()) throw MarifoldError.configInvalid('New session id cannot be empty.');

    const db = new Database(this.sessionsDb, { fileMustExist: true });
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
