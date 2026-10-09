import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionLeases } from '../src/sessions/SessionLeases';

it('excludes independent clients, renews, releases only for the owner, and expires crashed clients', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  let now = 0;
  const a = new SessionLeases(path.join(dir, 'leases.db'), () => now);
  const b = new SessionLeases(path.join(dir, 'leases.db'), () => now);
  try {
    a.acquire('session', 'first');
    expect(() => b.acquire('session', 'second')).toThrow('in use');
    const child = spawnSync(process.execPath, ['-e', `
      const { SessionLeases } = require(process.argv[1]);
      try { new SessionLeases(process.argv[2], () => 0).acquire('session', 'child'); process.exit(1); }
      catch (error) { process.exit(error.code === 'SESSION_BUSY' ? 0 : 2); }
    `, path.resolve('dist/sessions/SessionLeases.js'), path.join(dir, 'leases.db')]);
    expect(child.status).toBe(0);

    expect(() => b.assertAvailable('session', 'second')).toThrow('in use');
    b.release('session', 'second');
    expect(() => b.acquire('session', 'second')).toThrow('in use');
    now = 30_000;
    a.acquire('session', 'first');
    now = 61_000;
    expect(() => b.acquire('session', 'second')).toThrow('in use');
    a.release('session', 'first');
    b.acquire('session', 'second');
    now += 60_000;
    a.acquire('session', 'first');
    b.close(); // A stale owner's cleanup cannot release the new owner's claim.
    expect(() => b.acquire('session', 'second')).toThrow('in use');
    a.close();
    b.acquire('session', 'second');
  } finally { a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('holds a session for running work through a client release and renews it until the work ends', () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  let now = 0;
  const service = new SessionLeases(path.join(dir, 'leases.db'), () => now);
  const other = new SessionLeases(path.join(dir, 'leases.db'), () => now);
  try {
    service.acquire('web', 'tab');
    const endRun = service.hold('web', 'tab');
    service.release('web', 'tab'); // The tab closes while its run continues.
    expect(() => other.acquire('web', 'terminal')).toThrow('in use');
    now = 50_000;
    vi.advanceTimersByTime(45_000); // Renewals outlive the 60s lease.
    now = 100_000;
    expect(() => other.acquire('web', 'terminal')).toThrow('in use');
    endRun();
    endRun(); // Idempotent.
    // The tab's lease existed before the run, so it is left to expire.
    expect(() => other.acquire('web', 'terminal')).toThrow('in use');
    now = 200_000;
    other.acquire('web', 'terminal');

    // Work without a client lease (Telegram, schedules) releases what it created.
    const endChannelRun = service.hold('channel', 'service');
    expect(() => other.acquire('channel', 'terminal')).toThrow('in use');
    endChannelRun();
    other.acquire('channel', 'terminal');
    expect(() => service.hold('channel', 'service')).toThrow('in use');
  } finally {
    vi.useRealTimers();
    service.close();
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('prunes expired lease rows as clients acquire sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  const file = path.join(dir, 'leases.db');
  let now = 0;
  const leases = new SessionLeases(file, () => now);
  try {
    for (const id of ['a', 'b', 'c']) { leases.acquire(id, 'tab'); }
    now = 70_000;
    leases.acquire('d', 'tab');
    const db = new Database(file, { readonly: true });
    try {
      expect((db.prepare('SELECT session_id FROM leases').all() as Array<{ session_id: string }>).map(row => row.session_id)).toEqual(['d']);
    } finally { db.close(); }
  } finally { leases.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
