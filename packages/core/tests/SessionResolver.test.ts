import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionResolver } from '../src/sessions/SessionResolver';

const tempDirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-sessions-'));
  tempDirs.push(dir);
  return path.join(dir, 'sessions.db');
}

/** Create the session schema + one session/turn, in the default (DELETE) journal mode. */
function seed(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, profile_name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO sessions VALUES ('s1','default','2026-01-01','2026-01-01','{}')").run();
  db.prepare("INSERT INTO turns (session_id, role, content, timestamp) VALUES ('s1','user','hi','2026-01-01')").run();
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionResolver.checkIntegrity', () => {
  it('reports a healthy DB as ok with row counts', () => {
    const dbPath = tempDb();
    seed(dbPath);
    expect(new SessionResolver(dbPath).checkIntegrity()).toEqual({ ok: true, exists: true, sessions: 1, turns: 1 });
  });

  it('reports a missing DB as not-yet-existing (not an error)', () => {
    expect(new SessionResolver(tempDb()).checkIntegrity()).toEqual({ ok: true, exists: false });
  });

  it('flags a non-SQLite/garbage file as corrupt without throwing', () => {
    const dbPath = tempDb();
    fs.writeFileSync(dbPath, 'this is not a database');
    const health = new SessionResolver(dbPath).checkIntegrity();
    expect(health.ok).toBe(false);
    expect(health.exists).toBe(true);
    expect(health.error).toBeTruthy();
  });
});

describe('SessionResolver.list previews', () => {
  it('titles each session with its first user message, collapsed and truncated', () => {
    const dbPath = tempDb();
    seed(dbPath);
    const db = new Database(dbPath);
    // s1 already has user 'hi'. s2: assistant speaks first, long multi-line user message after.
    db.prepare("INSERT INTO sessions VALUES ('s2','default','2026-01-02','2026-01-02','{}')").run();
    db.prepare("INSERT INTO turns (session_id, role, content, timestamp) VALUES ('s2','assistant','welcome','2026-01-02')").run();
    db.prepare(
      "INSERT INTO turns (session_id, role, content, timestamp) VALUES ('s2','user',?, '2026-01-02')",
    ).run(`Please summarize\n  my notes about ${'x'.repeat(100)}`);
    // s3: no turns at all — no preview field.
    db.prepare("INSERT INTO sessions VALUES ('s3','default','2026-01-03','2026-01-03','{}')").run();
    db.close();

    const sessions = new SessionResolver(dbPath).list();
    const byId = new Map(sessions.map(session => [session.id, session]));
    expect(byId.get('s1')?.preview).toBe('hi');
    const long = byId.get('s2')?.preview;
    expect(long?.startsWith('Please summarize my notes about ')).toBe(true);
    expect(long?.endsWith('…')).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(80);
    expect(byId.get('s3')?.preview).toBeUndefined();
    expect('preview' in (byId.get('s3') ?? {})).toBe(false);
  });
});

describe('SessionResolver WAL hardening', () => {
  it('switches the DB into WAL mode on a normal operation', () => {
    const dbPath = tempDb();
    seed(dbPath); // created in DELETE mode

    new SessionResolver(dbPath).list(); // routes through open() -> sets journal_mode=WAL

    const probe = new Database(dbPath);
    expect(probe.pragma('journal_mode', { simple: true })).toBe('wal');
    probe.close();
  });
});
