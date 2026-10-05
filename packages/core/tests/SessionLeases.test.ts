import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
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
