import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';

/** Shared by independent local TUIs and the service. Stale clients expire. */
export class SessionLeases {
  private held = new Map<string, string>();
  /** Sessions reserved by running work in this process, by owner. */
  private pinned = new Map<string, { owner: string; count: number; timer: ReturnType<typeof setInterval> }>();
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

  /** Reserve a session for work started by `owner` until the returned function
   * is called, even if the owner's client disconnects or releases it meanwhile.
   * A lease the hold created is released at the end; an existing client lease
   * is left to that client's renewal or expiry. Throws SESSION_BUSY like
   * `acquire`. */
  hold(sessionId: string, owner: string): () => void {
    const pin = this.pinned.get(sessionId);
    if (pin && pin.owner !== owner) this.busy();
    const created = !this.ownedBy(sessionId, owner);
    this.acquire(sessionId, owner);
    if (pin) pin.count += 1;
    else {
      const timer = setInterval(() => {
        try { this.acquire(sessionId, owner); } catch { /* Another client took an expired lease. */ }
      }, 15_000);
      timer.unref?.();
      this.pinned.set(sessionId, { owner, count: 1, timer });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const current = this.pinned.get(sessionId);
      if (!current || --current.count > 0) return;
      clearInterval(current.timer);
      this.pinned.delete(sessionId);
      if (created) this.release(sessionId, owner);
    };
  }

  release(sessionId: string, owner: string): void {
    // Running work keeps its session; the client's release takes effect when it ends.
    if (this.pinned.get(sessionId)?.owner === owner) return;
    if (!fs.existsSync(this.file)) return;
    const db = this.open();
    try { db.prepare('DELETE FROM leases WHERE session_id = ? AND owner = ?').run(sessionId, owner); }
    finally { db.close(); }
    if (this.held.get(sessionId) === owner) this.held.delete(sessionId);
  }

  close(): void {
    for (const pin of this.pinned.values()) clearInterval(pin.timer);
    this.pinned.clear();
    for (const [id, owner] of this.held) this.release(id, owner);
  }

  private ownedBy(sessionId: string, owner: string): boolean {
    if (!fs.existsSync(this.file)) return false;
    const db = this.open();
    try {
      const lease = db.prepare('SELECT owner, expires_at FROM leases WHERE session_id = ?').get(sessionId) as { owner: string; expires_at: number } | undefined;
      return lease !== undefined && lease.owner === owner && lease.expires_at > this.now();
    } finally { db.close(); }
  }

  private busy(): never {
    throw new MarifoldError('SESSION_BUSY', 'This session is in use in another page or terminal. Close it there before opening it here.');
  }
}
