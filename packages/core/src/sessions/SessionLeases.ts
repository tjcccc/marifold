import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';

/** Shared by independent local TUIs and the service. Stale clients expire. */
export class SessionLeases {
  private held = new Map<string, string>();
  /** Sessions reserved by running work in this process, by owner. */
  private pinned = new Map<string, { owner: string; count: number; timer: ReturnType<typeof setInterval> }>();
  /** Releases refused while running work pinned the session, applied when it ends. */
  private releaseWhenUnpinned = new Set<string>();
  /** This process's claim on the sessions it runs work in (see `hold`). */
  private readonly runToken = randomUUID();
  constructor(private readonly file: string, private readonly now = Date.now) {}

  private open(): Database.Database {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new Database(this.file, { timeout: 5000 });
    db.exec('CREATE TABLE IF NOT EXISTS leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS runs (session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    return db;
  }

  acquire(sessionId: string, owner: string): void {
    const db = this.open();
    try {
      const now = this.now();
      // Expired rows mean nothing; drop them so the table stays small.
      db.prepare('DELETE FROM leases WHERE expires_at <= ? AND session_id != ?').run(now, sessionId);
      const result = db.prepare(`INSERT INTO leases VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE leases.owner = excluded.owner OR leases.expires_at <= ?`).run(sessionId, owner, now + 60_000, now);
      if (!result.changes) { this.busy(); }
      this.held.set(sessionId, owner);
      if (this.pinned.get(sessionId)?.owner === owner) { this.releaseWhenUnpinned.delete(sessionId); }
    } finally { db.close(); }
  }

  /** Move a session to `owner` even while another client holds it. A
   * workspace belongs to one person, so this is how they continue a session on
   * another device. The displaced client finds out at its next renewal; work
   * it started keeps running under the new owner and still saves its turn. */
  takeover(sessionId: string, owner: string): void {
    const db = this.open();
    try {
      db.prepare(`INSERT INTO leases VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`)
        .run(sessionId, owner, this.now() + 60_000);
    } finally { db.close(); }
    this.held.set(sessionId, owner);
    this.releaseWhenUnpinned.delete(sessionId);
    const pin = this.pinned.get(sessionId);
    if (pin) { pin.owner = owner; }
  }

  assertAvailable(sessionId: string, owner?: string): void {
    if (!fs.existsSync(this.file)) { return; }
    const db = this.open();
    try {
      const lease = db.prepare('SELECT owner, expires_at FROM leases WHERE session_id = ?').get(sessionId) as { owner: string; expires_at: number } | undefined;
      if (lease && lease.expires_at > this.now() && lease.owner !== owner) { this.busy(); }
    } finally { db.close(); }
  }

  /** Mark the sessions another owner holds right now as `inUse`, for list views. */
  markInUse<T extends { id: string; inUse?: boolean }>(sessions: T[], owner?: string): T[] {
    if (sessions.length === 0 || !fs.existsSync(this.file)) { return sessions; }
    const held = new Set<string>();
    const db = this.open();
    try {
      const leases = db.prepare('SELECT session_id, owner FROM leases WHERE expires_at > ?').all(this.now()) as Array<{ session_id: string; owner: string }>;
      for (const lease of leases) {
        if (lease.owner !== owner) { held.add(lease.session_id); }
      }
    } finally { db.close(); }
    return held.size === 0 ? sessions : sessions.map(session => held.has(session.id) ? { ...session, inUse: true } : session);
  }

  /** Reserve a session for work started by `owner` until the returned function
   * is called, even if the owner's client disconnects or releases it meanwhile.
   * A lease the hold created is released at the end; an existing client lease
   * is left to that client's renewal or expiry. Throws SESSION_BUSY like
   * `acquire`. */
  hold(sessionId: string, owner: string): () => void {
    const pin = this.pinned.get(sessionId);
    if (pin && pin.owner !== owner) { this.busy(); }
    const created = !this.ownedBy(sessionId, owner);
    // One app on a device may be open in several pages or terminals, but only
    // one process runs work in a session at a time.
    if (!pin) { this.claimRun(sessionId); }
    try { this.acquire(sessionId, owner); } catch (error) {
      if (!pin) { this.releaseRun(sessionId); }
      throw error;
    }
    if (pin) { pin.count += 1; }
    else {
      // Renew for whoever owns the session now; a takeover moves the hold too.
      const timer = setInterval(() => {
        const current = this.pinned.get(sessionId);
        if (!current) { return; }
        try { this.acquire(sessionId, current.owner); } catch { /* Another client took an expired lease. */ }
        try { this.claimRun(sessionId); } catch { /* Kept by this process unless it stalled past expiry. */ }
      }, 15_000);
      timer.unref?.();
      this.pinned.set(sessionId, { owner, count: 1, timer });
    }
    let done = false;
    return () => {
      if (done) { return; }
      done = true;
      const current = this.pinned.get(sessionId);
      if (!current || --current.count > 0) { return; }
      clearInterval(current.timer);
      this.pinned.delete(sessionId);
      this.releaseRun(sessionId);
      const deferred = this.releaseWhenUnpinned.delete(sessionId);
      // A lease this hold created goes with it (a takeover's lease is another owner's and stays);
      // a release its owner asked for during the work applies now.
      if (created) { this.release(sessionId, owner); }
      if (deferred) { this.release(sessionId, current.owner); }
    };
  }

  private claimRun(sessionId: string): void {
    const db = this.open();
    try {
      const now = this.now();
      const result = db.prepare(`INSERT INTO runs VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE runs.token = excluded.token OR runs.expires_at <= ?`).run(sessionId, this.runToken, now + 60_000, now);
      if (!result.changes) {
        throw new MarifoldError('SESSION_BUSY', 'A task is already running in this session. Wait for it to finish, or stop it, before starting another.');
      }
    } finally { db.close(); }
  }

  private releaseRun(sessionId: string): void {
    const db = this.open();
    try { db.prepare('DELETE FROM runs WHERE session_id = ? AND token = ?').run(sessionId, this.runToken); }
    finally { db.close(); }
  }

  release(sessionId: string, owner: string): void {
    // Running work keeps its session; the client's release takes effect when it ends.
    if (this.pinned.get(sessionId)?.owner === owner) { this.releaseWhenUnpinned.add(sessionId); return; }
    if (!fs.existsSync(this.file)) { return; }
    const db = this.open();
    try { db.prepare('DELETE FROM leases WHERE session_id = ? AND owner = ?').run(sessionId, owner); }
    finally { db.close(); }
    if (this.held.get(sessionId) === owner) { this.held.delete(sessionId); }
  }

  close(): void {
    for (const pin of this.pinned.values()) { clearInterval(pin.timer); }
    this.pinned.clear();
    for (const [id, owner] of this.held) { this.release(id, owner); }
  }

  private ownedBy(sessionId: string, owner: string): boolean {
    if (!fs.existsSync(this.file)) { return false; }
    const db = this.open();
    try {
      const lease = db.prepare('SELECT owner, expires_at FROM leases WHERE session_id = ?').get(sessionId) as { owner: string; expires_at: number } | undefined;
      return lease !== undefined && lease.owner === owner && lease.expires_at > this.now();
    } finally { db.close(); }
  }

  private busy(): never {
    throw new MarifoldError('SESSION_BUSY', 'This session is in use in another page, terminal, or app. Close it there before opening it here.');
  }
}
