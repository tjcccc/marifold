import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SQLiteSessionStore } from '@priest-ai/core';
import { SessionSummary } from '../config/ConfigSchema';
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

  close(): void {
    this.store?.close();
    this.store = undefined;
  }
}
