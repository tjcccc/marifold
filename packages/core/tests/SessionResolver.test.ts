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

describe('SessionResolver display metadata', () => {
  it('renames and pins without changing turns, recency, or compaction metadata', async () => {
    const dbPath = tempDb();
    seed(dbPath);
    const db = new Database(dbPath);
    db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ __compaction: { summary: 'keep me' } }), 's1');
    db.prepare("INSERT INTO sessions VALUES ('s2','default','2026-01-02','2026-01-02','{}')").run();
    db.prepare("INSERT INTO turns (session_id, role, content, timestamp) VALUES ('s2','user','newer','2026-01-02')").run();
    db.close();

    const resolver = new SessionResolver(dbPath);
    const store = resolver.openStore();
    const staleModelSession = await store.get('s1');
    expect(resolver.updateDisplay('s1', { title: 'Important chat', pinned: true })).toBe(true);
    expect(resolver.list().map(session => session.id)).toEqual(['s1', 's2']);
    expect(resolver.latest()?.id).toBe('s2');
    expect(resolver.get('s1')).toMatchObject({
      title: 'Important chat',
      pinned: true,
      updatedAt: '2026-01-01',
      turns: [{ content: 'hi' }],
    });

    const probe = new Database(dbPath, { fileMustExist: true });
    const row = probe.prepare('SELECT metadata FROM sessions WHERE id = ?').get('s1') as { metadata: string };
    expect(JSON.parse(row.metadata)).toEqual({ __compaction: { summary: 'keep me' } });
    expect(probe.prepare('SELECT title, pinned FROM marifold_session_display WHERE session_id = ?').get('s1'))
      .toEqual({ title: 'Important chat', pinned: 1 });
    probe.close();

    // A provider turn may have loaded the Priest session before the sidebar
    // action. Its later save replaces Priest's metadata blob, but must not
    // overwrite Marifold's separate display row.
    if (staleModelSession) await store.save(staleModelSession);
    expect(resolver.get('s1')).toMatchObject({ title: 'Important chat', pinned: true });

    expect(resolver.updateDisplay('s1', { title: null, pinned: false })).toBe(true);
    expect(resolver.get('s1')).not.toHaveProperty('title');
    expect(resolver.get('s1')).not.toHaveProperty('pinned');
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

describe('SessionResolver turn attachments', () => {
  it('persists embedded images beside the user turn and removes them with the session', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange(
      'with-image',
      'default',
      'Describe this image.',
      'It is a small test image.',
      [{ data: 'aW1hZ2UtYnl0ZXM=', mediaType: 'image/png' }],
    );

    expect(resolver.get('with-image')?.turns).toMatchObject([
      {
        role: 'user',
        content: 'Describe this image.',
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }],
      },
      { role: 'assistant', content: 'It is a small test image.' },
    ]);

    // Priest rewrites all turn rows on save; the attachment must remain tied
    // to the first user turn after another exchange changes every SQLite id.
    await resolver.appendExchange('with-image', 'default', 'One more question.', 'One more answer.');
    expect(resolver.get('with-image')?.turns[0]?.attachments).toMatchObject([
      { kind: 'image', mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' },
    ]);

    expect(resolver.delete('with-image')).toBe(true);
    const db = new Database(dbPath, { fileMustExist: true });
    const count = db.prepare('SELECT count(*) AS count FROM marifold_turn_attachments').get() as { count: number };
    expect(count.count).toBe(0);
    db.close();
    resolver.close();
  });

  it('truncates an edited branch by stable user-turn ordinal', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange('branch', 'default', 'Conversation 1', 'Answer 1', [
      { data: 'Zmlyc3Q=', mediaType: 'image/png' },
    ]);
    await resolver.appendExchange('branch', 'default', 'Conversation 2', 'Answer 2', [
      { data: 'c2Vjb25k', mediaType: 'image/jpeg' },
    ]);
    await resolver.appendExchange('branch', 'default', 'Conversation 3', 'Answer 3');

    expect(resolver.truncateFromUserTurn('branch', 1)).toEqual({ found: true, removedTurns: 4 });
    expect(resolver.get('branch')?.turns).toMatchObject([
      {
        role: 'user',
        content: 'Conversation 1',
        attachments: [{ data: 'Zmlyc3Q=', mediaType: 'image/png' }],
      },
      { role: 'assistant', content: 'Answer 1' },
    ]);

    await resolver.appendExchange('branch', 'default', 'Updated conversation 2', 'Updated answer 2');
    expect(resolver.get('branch')?.turns.map(turn => turn.content)).toEqual([
      'Conversation 1',
      'Answer 1',
      'Updated conversation 2',
      'Updated answer 2',
    ]);
    resolver.close();
  });

  it('replaces one exchange in place without deleting later turns', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange('replace', 'default', 'Conversation 1', 'Answer 1');
    await resolver.appendExchange('replace', 'default', 'Conversation 2', 'Answer 2', [
      { data: 'b2xk', mediaType: 'image/png' },
    ]);
    await resolver.appendExchange('replace', 'default', 'Conversation 3', 'Answer 3');

    expect(resolver.turnsBeforeUserTurn('replace', 1)?.map(turn => turn.content)).toEqual([
      'Conversation 1',
      'Answer 1',
    ]);
    expect(resolver.replaceExchange(
      'replace',
      1,
      'Updated conversation 2',
      'Updated answer 2',
      [{ data: 'bmV3', mediaType: 'image/jpeg' }],
    )).toEqual({ found: true, replaced: true });
    expect(resolver.get('replace')?.turns).toMatchObject([
      { role: 'user', content: 'Conversation 1' },
      { role: 'assistant', content: 'Answer 1' },
      {
        role: 'user',
        content: 'Updated conversation 2',
        attachments: [{ data: 'bmV3', mediaType: 'image/jpeg' }],
      },
      { role: 'assistant', content: 'Updated answer 2' },
      { role: 'user', content: 'Conversation 3' },
      { role: 'assistant', content: 'Answer 3' },
    ]);
    resolver.close();
  });
});
