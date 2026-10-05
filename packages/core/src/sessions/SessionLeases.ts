import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';

/** Shared by independent local TUIs and the service. Stale clients expire. */
export class SessionLeases {
  private held = new Map<string, string>();
  constructor(private readonly file: string, private readonly now = Date.now) {}

  private open(): Database.Database {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new Database(this.file, { timeout: 5000 });
    db.exec('CREATE TABLE IF NOT EXISTS leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    return db;
  }

  acquire(sessionId: string, owner: string): void {
    const db = this.open();
    try {
      const now = this.now();
      const result = db.prepare(`INSERT INTO leases VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE leases.owner = excluded.owner OR leases.expires_at <= ?`).run(sessionId, owner, now + 60_000, now);
      if (!result.changes) this.busy();
      this.held.set(sessionId, owner);
    } finally { db.close(); }
  }

  assertAvailable(sessionId: string, owner?: string): void {
    if (!fs.existsSync(this.file)) return;
    const db = this.open();
    try {
      const lease = db.prepare('SELECT owner, expires_at FROM leases WHERE session_id = ?').get(sessionId) as { owner: string; expires_at: number } | undefined;
      if (lease && lease.expires_at > this.now() && lease.owner !== owner) this.busy();
    } finally { db.close(); }
  }

  release(sessionId: string, owner: string): void {
    if (!fs.existsSync(this.file)) return;
    const db = this.open();
    try { db.prepare('DELETE FROM leases WHERE session_id = ? AND owner = ?').run(sessionId, owner); }
    finally { db.close(); }
    if (this.held.get(sessionId) === owner) this.held.delete(sessionId);
  }

  close(): void {
    for (const [id, owner] of this.held) this.release(id, owner);
  }

  private busy(): never {
    throw new MarifoldError('SESSION_BUSY', 'This session is in use in another page or terminal. Close it there before opening it here.');
  }
}
