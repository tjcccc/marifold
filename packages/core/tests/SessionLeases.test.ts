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

it('moves a session and its running work to the device that takes it over', () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  let now = 0;
  const leases = new SessionLeases(path.join(dir, 'leases.db'), () => now);
  try {
    leases.acquire('shared', 'office');
    const endRun = leases.hold('shared', 'office');
    leases.takeover('shared', 'home');
    expect(() => leases.acquire('shared', 'office')).toThrow('in use');
    now = 50_000;
    vi.advanceTimersByTime(45_000); // The run's hold now renews for home.
    now = 100_000;
    expect(() => leases.acquire('shared', 'office')).toThrow('in use');
    leases.acquire('shared', 'home');
    endRun();
    expect(() => leases.acquire('shared', 'office')).toThrow('in use');
    leases.takeover('fresh', 'home'); // Taking over an unclaimed session just claims it.
    expect(() => leases.acquire('fresh', 'office')).toThrow('in use');
  } finally {
    vi.useRealTimers();
    leases.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('lets one owner open a session in several processes but run work in only one at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  const first = new SessionLeases(path.join(dir, 'leases.db'));
  const second = new SessionLeases(path.join(dir, 'leases.db'));
  try {
    const done = first.hold('session', 'local.terminal');
    expect(() => second.acquire('session', 'local.terminal')).not.toThrow();
    expect(() => second.hold('session', 'local.terminal')).toThrow('already running');
    expect(() => second.acquire('session', 'local.web')).toThrow('in use');
    done();
    const again = second.hold('session', 'local.terminal');
    again();
  } finally { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('applies a release refused while work ran once that work ends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  const leases = new SessionLeases(path.join(dir, 'leases.db'));
  const other = new SessionLeases(path.join(dir, 'leases.db'));
  try {
    leases.acquire('session', 'local.web');
    const done = leases.hold('session', 'local.web');
    leases.release('session', 'local.web');
    expect(() => other.acquire('session', 'local.terminal')).toThrow('in use');
    done();
    expect(() => other.acquire('session', 'local.terminal')).not.toThrow();
  } finally { leases.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('keeps a lease taken over during work when that work ends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-leases-'));
  const leases = new SessionLeases(path.join(dir, 'leases.db'));
  const other = new SessionLeases(path.join(dir, 'leases.db'));
  try {
    const done = leases.hold('session', 'local.web');
    leases.takeover('session', 'device-b.web');
    done();
    expect(() => other.acquire('session', 'local.terminal')).toThrow('in use');
  } finally { leases.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
