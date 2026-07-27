import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionResolver } from '../src/sessions/SessionResolver';
import type { ResponseMetrics } from '../src/sessions/ResponseMetrics';

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
    expect(resolver.list(50, 'default', { order: 'recent' }).map(session => session.id)).toEqual(['s2', 's1']);
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

  it('archives sessions and searches titles or first-message previews server-side', () => {
    const dbPath = tempDb();
    seed(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO sessions VALUES ('s2','default','2026-01-02','2026-01-02','{}')").run();
    db.prepare("INSERT INTO turns (session_id, role, content, timestamp) VALUES ('s2','user','Trip planning notes','2026-01-02')").run();
    db.close();

    const resolver = new SessionResolver(dbPath);
    expect(resolver.updateDisplay('s1', { title: 'Pinned research', archived: true })).toBe(true);
    expect(resolver.list().map(session => session.id)).toEqual(['s2']);
    expect(resolver.list(50, 'default', { archived: true })).toMatchObject([
      { id: 's1', title: 'Pinned research', archived: true },
    ]);
    expect(resolver.list(50, 'default', { search: 'trip' }).map(session => session.id)).toEqual(['s2']);
    expect(resolver.list(50, 'default', { archived: true, search: 'research' }).map(session => session.id))
      .toEqual(['s1']);
  });

  it('migrates the v0.48 display table before reading archive state', () => {
    const dbPath = tempDb();
    seed(dbPath);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE marifold_session_display (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
      )
    `);
    db.prepare("INSERT INTO marifold_session_display VALUES ('s1', 'Legacy title', 1)").run();
    db.close();

    const resolver = new SessionResolver(dbPath);
    expect(resolver.list()).toMatchObject([{ id: 's1', title: 'Legacy title', pinned: true }]);
    const probe = new Database(dbPath, { fileMustExist: true });
    const columns = probe.prepare('PRAGMA table_info(marifold_session_display)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('archived');
    probe.close();
  });
});

describe('SessionResolver profile activity', () => {
  it('summarizes the latest session response and persists profile pin state', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange(
      'writer-old',
      'writer',
      'Old prompt',
      'Old answer',
    );
    await resolver.appendExchange(
      'writer-new',
      'writer',
      'New prompt',
      '\n## Fresh answer\nsecond line should not appear',
    );
    await resolver.appendExchange(
      'painter-session',
      'painter',
      'Paint',
      'Painter answer',
    );

    const db = new Database(dbPath);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-07-20T00:00:00.000Z', 'writer-old');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-07-24T08:00:00.000Z', 'writer-new');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-07-23T08:00:00.000Z', 'painter-session');
    db.close();

    resolver.setProfilePinned('writer', true);
    resolver.setProfilePinned('empty-profile', true);
    expect(resolver.profileActivity()).toEqual(expect.arrayContaining([
      {
        profileName: 'writer',
        pinned: true,
        updatedAt: '2026-07-24T08:00:00.000Z',
        preview: 'Fresh answer',
      },
      {
        profileName: 'painter',
        updatedAt: '2026-07-23T08:00:00.000Z',
        preview: 'Painter answer',
      },
      { profileName: 'empty-profile', pinned: true },
    ]));

    resolver.deleteProfileDisplay('writer');
    expect(resolver.profileActivity().find(item => item.profileName === 'writer')).toMatchObject({
      profileName: 'writer',
      updatedAt: '2026-07-24T08:00:00.000Z',
      preview: 'Fresh answer',
    });
    expect(resolver.profileActivity().find(item => item.profileName === 'writer')).not.toHaveProperty('pinned');
    resolver.close();
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
        attachments: [{
          kind: 'image',
          mediaType: 'image/png',
          ref: { userTurnIndex: 0, attachmentIndex: 0 },
        }],
      },
      { role: 'assistant', content: 'It is a small test image.' },
    ]);

    // Priest rewrites all turn rows on save; the attachment must remain tied
    // to the first user turn after another exchange changes every SQLite id.
    await resolver.appendExchange('with-image', 'default', 'One more question.', 'One more answer.');
    expect(resolver.get('with-image')?.turns[0]?.attachments).toMatchObject([
      { kind: 'image', mediaType: 'image/png', ref: { userTurnIndex: 0, attachmentIndex: 0 } },
    ]);
    expect(resolver.getAttachment('with-image', 0, 0)).toEqual({
      mediaType: 'image/png',
      data: 'aW1hZ2UtYnl0ZXM=',
    });

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
        attachments: [{ mediaType: 'image/png', ref: { userTurnIndex: 0, attachmentIndex: 0 } }],
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
        attachments: [{ mediaType: 'image/jpeg', ref: { userTurnIndex: 1, attachmentIndex: 0 } }],
      },
      { role: 'assistant', content: 'Updated answer 2' },
      { role: 'user', content: 'Conversation 3' },
      { role: 'assistant', content: 'Answer 3' },
    ]);
    resolver.close();
  });

  it('can preserve a display-only skill invocation after a model-facing prompt is saved', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange('skill', 'default', 'summer morning', 'Generated prompt');

    expect(resolver.replaceLastUserTurn('skill', '$make-grok-imagine-prompt "summer morning"')).toBe(true);
    expect(resolver.get('skill')?.turns.map(turn => turn.content)).toEqual([
      '$make-grok-imagine-prompt "summer morning"',
      'Generated prompt',
    ]);
    resolver.close();
  });
});

describe('SessionResolver response metrics', () => {
  const chatMetrics: ResponseMetrics = {
    mode: 'chat',
    provider: 'xai',
    model: 'grok-4.5',
    think: true,
    startedAt: '2026-07-27T03:00:00.000Z',
    finishedAt: '2026-07-27T03:00:18.000Z',
    latencyMs: 18_000,
    usage: {
      inputTokens: 7_000,
      outputTokens: 600,
      totalTokens: 7_600,
      cachedInputTokens: 2_000,
      reasoningTokens: 120,
      estimatedCostUSD: 0.0123,
    },
  };

  it('replays, replaces, renames, truncates, deletes, and clears durable metrics by user-turn ordinal', async () => {
    const dbPath = tempDb();
    const resolver = new SessionResolver(dbPath);
    await resolver.appendExchange(
      'metrics',
      'default',
      'Conversation 1',
      'Answer 1',
      undefined,
      chatMetrics,
    );
    await resolver.appendExchange(
      'metrics',
      'default',
      'Conversation 2',
      'Answer 2',
      undefined,
      {
        ...chatMetrics,
        mode: 'agent',
        provider: 'chatgpt',
        model: 'gpt-5-codex',
        think: false,
        latencyMs: 2_500,
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      },
    );

    expect(resolver.get('metrics')?.turns).toMatchObject([
      { role: 'user', content: 'Conversation 1' },
      { role: 'assistant', content: 'Answer 1', responseMetrics: chatMetrics },
      { role: 'user', content: 'Conversation 2' },
      {
        role: 'assistant',
        content: 'Answer 2',
        responseMetrics: {
          mode: 'agent',
          provider: 'chatgpt',
          model: 'gpt-5-codex',
          latencyMs: 2_500,
          usage: { totalTokens: 125 },
        },
      },
    ]);

    const replacement = {
      ...chatMetrics,
      model: 'grok-4.5-fast',
      latencyMs: 9_000,
      usage: { inputTokens: 4_000, outputTokens: 400, totalTokens: 4_400 },
    };
    expect(resolver.replaceExchange(
      'metrics',
      0,
      'Updated conversation 1',
      'Updated answer 1',
      undefined,
      replacement,
    )).toEqual({ found: true, replaced: true });
    expect(resolver.get('metrics')?.turns[1]).toMatchObject({
      content: 'Updated answer 1',
      responseMetrics: replacement,
    });

    expect(resolver.replaceExchange(
      'metrics',
      0,
      'Updated conversation without metrics',
      'Updated answer without metrics',
    )).toEqual({ found: true, replaced: true });
    expect(resolver.get('metrics')?.turns[1]).not.toHaveProperty('responseMetrics');
    expect(resolver.replaceExchange(
      'metrics',
      0,
      'Updated conversation 1',
      'Updated answer 1',
      undefined,
      replacement,
    )).toEqual({ found: true, replaced: true });

    expect(resolver.rename('metrics', 'metrics-renamed')).toBe(true);
    expect(resolver.get('metrics-renamed')?.turns[1]).toMatchObject({ responseMetrics: replacement });
    expect(resolver.truncateFromUserTurn('metrics-renamed', 1)).toEqual({ found: true, removedTurns: 2 });

    const db = new Database(dbPath, { fileMustExist: true });
    expect((db.prepare('SELECT count(*) AS count FROM marifold_response_metrics').get() as { count: number }).count)
      .toBe(1);
    db.close();

    expect(resolver.delete('metrics-renamed')).toBe(true);
    const deletedProbe = new Database(dbPath, { fileMustExist: true });
    expect((deletedProbe.prepare('SELECT count(*) AS count FROM marifold_response_metrics').get() as { count: number }).count)
      .toBe(0);
    deletedProbe.close();

    await resolver.appendExchange(
      'metrics-clear',
      'default',
      'Conversation to clear',
      'Answer to clear',
      undefined,
      chatMetrics,
    );
    expect(resolver.clear()).toEqual({ count: 1, ids: ['metrics-clear'] });
    const clearedProbe = new Database(dbPath, { fileMustExist: true });
    expect((clearedProbe.prepare('SELECT count(*) AS count FROM marifold_response_metrics').get() as { count: number }).count)
      .toBe(0);
    clearedProbe.close();
    resolver.close();
  });
});
