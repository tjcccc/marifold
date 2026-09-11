import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  bridgeOrigin,
  createIdentity,
  digest,
  identifier,
  INVITATION_TTL_MS,
  issueMembership,
  label,
  publicIdentity,
  randomId,
} from '@marifold/workspace-protocol';
import type {
  Invitation,
  PrivateIdentity,
  PublicIdentity,
  SignedMembership,
  WorkspaceSummary,
} from '@marifold/workspace-protocol';

export interface WorkspaceConnection extends Omit<WorkspaceSummary, 'online'> {
  identity: PrivateIdentity;
  certificate: SignedMembership;
  host: PublicIdentity;
  executor: boolean;
}
export class WorkspaceStore {
  readonly directory: string;
  private readonly db: Database.Database;
  private closed = false;
  private readonly lockPath: string;
  private readonly lockValue = JSON.stringify({ pid: process.pid, instance: randomId() });
  private lastPruned = 0;
  constructor(configPath: string) {
    this.directory = path.join(
      path.dirname(path.resolve(configPath)),
      'workspaces',
      digest(path.basename(configPath)).slice(0, 16),
    );
    const parent = path.dirname(this.directory);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Workspace state parent must not be a symlink.');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink())
      throw new Error('Workspace state directory must not be a symlink.');
    fs.chmodSync(this.directory, 0o700);
    this.lockPath = path.join(this.directory, 'service.lock');
    this.acquireLock();
    try {
      const dbPath = path.join(this.directory, 'control.db');
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Workspace control files must be regular files.');
          fs.chmodSync(file, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.db = new Database(dbPath);
      fs.chmodSync(dbPath, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_records (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events (run TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(run,seq));
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (workspace TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (workspace TEXT NOT NULL, id TEXT NOT NULL, certificate TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (workspace TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, PRIMARY KEY(workspace,sender,id));
    `);
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }
  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, this.lockValue, { flag: 'wx', mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const fd = fs.openSync(this.lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let pid: unknown;
      try {
        if (fs.fstatSync(fd).size > 1024) throw new Error('Invalid workspace service lock.');
        pid = JSON.parse(fs.readFileSync(fd, 'utf8')).pid;
      } finally {
        fs.closeSync(fd);
      }
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid workspace service lock.');
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          fs.unlinkSync(this.lockPath);
          continue;
        }
        throw error;
      }
      throw new Error('This configuration already has an active workspace service.');
    }
    throw new Error('Could not acquire the workspace service lock.');
  }
  private releaseLock(): void {
    try {
      if (fs.readFileSync(this.lockPath, 'utf8') === this.lockValue) fs.unlinkSync(this.lockPath);
    } catch {
      /* Already released. */
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.db.close();
      } finally {
        this.releaseLock();
      }
    }
  }
  private prune(): void {
    if (Date.now() - this.lastPruned < 60000) return;
    this.lastPruned = Date.now();
    this.db
      .prepare('DELETE FROM run_events WHERE run IN (SELECT id FROM run_records WHERE expires < ?)')
      .run(Date.now());
    this.db.prepare('DELETE FROM run_records WHERE expires < ?').run(Date.now());
    // Keep request tombstones: forgetting an old id would authorize its replay.
    this.db
      .prepare("UPDATE requests SET result=NULL,state='expired' WHERE created < ? AND state IN ('complete','failed')")
      .run(Date.now() - 86400000);
  }
  readonly runJournal = {
    load: (): Array<{
      record: import('../runs/RunRegistry').RunRecord;
      events: import('../runs/RunRegistry').SequencedEvent[];
    }> => {
      this.db
        .prepare('DELETE FROM run_events WHERE run IN (SELECT id FROM run_records WHERE expires < ?)')
        .run(Date.now());
      this.db.prepare('DELETE FROM run_records WHERE expires < ?').run(Date.now());
      return (
        this.db.prepare('SELECT id,record FROM run_records ORDER BY expires DESC LIMIT 55').all() as {
          id: string;
          record: string;
        }[]
      ).map((row) => ({
        record: JSON.parse(row.record),
        events: (
          this.db.prepare('SELECT seq,event FROM run_events WHERE run=? ORDER BY seq DESC LIMIT 10000').all(row.id) as {
            seq: number;
            event: string;
          }[]
        )
          .reverse()
          .map((e) => ({ seq: e.seq, event: JSON.parse(e.event) })),
      }));
    },
    save: (
      record: import('../runs/RunRegistry').RunRecord,
      event?: import('../runs/RunRegistry').SequencedEvent,
    ): void => {
      if (this.closed) return;
      this.prune();
      this.db.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO run_records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,expires=excluded.expires',
          )
          .run(record.id, JSON.stringify(record), Date.now() + 86400000);
        if (event)
          this.db
            .prepare('INSERT OR REPLACE INTO run_events VALUES (?,?,?)')
            .run(record.id, event.seq, JSON.stringify(event.event));
        this.db.prepare('DELETE FROM run_events WHERE run=? AND seq<=?').run(record.id, record.eventCount - 10000);
      })();
    },
  };
  list(): WorkspaceConnection[] {
    const rows = this.db.prepare('SELECT id,metadata FROM connections ORDER BY id').all() as {
      id: string;
      metadata: string;
    }[];
    return rows.map((row) => ({ ...JSON.parse(row.metadata), identity: this.readIdentity(row.id) }));
  }
  get(idOrName: string): WorkspaceConnection {
    const matches = this.list().filter((c) => c.id === idOrName || c.name === idOrName);
    if (matches.length !== 1)
      throw new Error(matches.length ? 'Workspace name is ambiguous; use its ID.' : 'Workspace not found.');
    return matches[0];
  }
  save(connection: WorkspaceConnection): void {
    identifier(connection.id);
    label(connection.name);
    bridgeOrigin(connection.bridgeUrl);
    this.writeIdentity(connection.id, connection.identity);
    const { identity: _identity, ...metadata } = connection;
    this.db
      .prepare('INSERT INTO connections VALUES (?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata')
      .run(connection.id, JSON.stringify(metadata));
  }
  async create(name: string, bridgeUrl: string, deviceName: string): Promise<WorkspaceConnection> {
    if (this.list().some((c) => c.role === 'host')) throw new Error('This configuration already hosts a workspace.');
    const identity = await createIdentity();
    const id = randomId();
    const deviceId = randomId();
    const host = publicIdentity(identity);
    const certificate = issueMembership(identity, {
      version: 1,
      workspaceId: id,
      deviceId,
      name: label(deviceName),
      identity: host,
      host,
      issuedAt: Date.now(),
    });
    const connection: WorkspaceConnection = {
      id,
      name: label(name),
      bridgeUrl: bridgeOrigin(bridgeUrl),
      deviceId,
      hostDeviceId: deviceId,
      role: 'host',
      host,
      identity,
      certificate,
      executor: true,
    };
    this.save(connection);
    this.addDevice(certificate);
    return connection;
  }
  invite(id: string): string {
    const c = this.get(id);
    if (c.role !== 'host') throw new Error('Invitations must be issued by the host.');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + INVITATION_TTL_MS;
    this.db
      .prepare(
        'INSERT INTO invitations VALUES (?,?,?) ON CONFLICT(workspace) DO UPDATE SET verifier=excluded.verifier,expires=excluded.expires',
      )
      .run(c.id, digest(secret), expiresAt);
    const invitation: Invitation = {
      version: 1,
      workspaceId: c.id,
      bridgeUrl: c.bridgeUrl,
      host: c.host,
      secret,
      expiresAt,
    };
    return Buffer.from(JSON.stringify(invitation)).toString('base64url');
  }
  validateInvitation(workspace: string, secret: unknown): void {
    const invitation = this.db.prepare('SELECT verifier,expires FROM invitations WHERE workspace=?').get(workspace) as
      | { verifier: string; expires: number }
      | undefined;
    if (
      typeof secret !== 'string' ||
      secret.length > 100 ||
      !invitation ||
      invitation.expires < Date.now() ||
      !timingSafeEqual(Buffer.from(invitation.verifier), Buffer.from(digest(secret)))
    )
      throw new Error('Invitation is invalid or expired.');
  }
  enroll(id: string, secret: string, deviceId: string, name: string, identity: PublicIdentity): SignedMembership {
    const c = this.get(id);
    if (c.role !== 'host') throw new Error('Only a host may enroll a device.');
    return this.db.transaction(() => {
      const invitation = this.db.prepare('SELECT verifier,expires FROM invitations WHERE workspace=?').get(c.id) as
        | { verifier: string; expires: number }
        | undefined;
      if (
        !invitation ||
        invitation.expires < Date.now() ||
        !timingSafeEqual(Buffer.from(invitation.verifier), Buffer.from(digest(secret)))
      )
        throw new Error('Invitation is invalid or expired.');
      const certificate = issueMembership(c.identity, {
        version: 1,
        workspaceId: c.id,
        deviceId: identifier(deviceId),
        name: label(name),
        identity,
        host: c.host,
        issuedAt: Date.now(),
      });
      this.addDevice(certificate);
      this.db.prepare('DELETE FROM invitations WHERE workspace=?').run(c.id);
      return certificate;
    })();
  }
  addDevice(certificate: SignedMembership): void {
    const m = certificate.membership;
    this.db
      .prepare(
        'INSERT INTO devices VALUES (?,?,?,0) ON CONFLICT(workspace,id) DO UPDATE SET certificate=excluded.certificate,revoked=0',
      )
      .run(m.workspaceId, m.deviceId, JSON.stringify(certificate));
  }
  devices(workspace: string): Array<{ certificate: SignedMembership; revoked: boolean }> {
    return (
      this.db.prepare('SELECT certificate,revoked FROM devices WHERE workspace=?').all(workspace) as {
        certificate: string;
        revoked: number;
      }[]
    ).map((r) => ({ certificate: JSON.parse(r.certificate), revoked: Boolean(r.revoked) }));
  }
  revoke(workspace: string, deviceId: string): void {
    if (this.get(workspace).hostDeviceId === deviceId) throw new Error('Remove the hosted workspace to stop sharing.');
    this.db.prepare('UPDATE devices SET revoked=1 WHERE workspace=? AND id=?').run(workspace, deviceId);
  }
  rename(id: string, name: string): void {
    const c = this.get(id);
    this.save({ ...c, name: label(name) });
  }
  remove(id: string): void {
    const c = this.get(id);
    this.db.transaction(() => {
      for (const table of ['devices', 'invitations', 'requests'])
        this.db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(c.id);
      this.db.prepare('DELETE FROM connections WHERE id=?').run(c.id);
      if (this.defaultId() === c.id) this.setDefault('local');
    })();
    fs.rmSync(path.join(this.directory, `${c.id}.credentials.json`), { force: true });
  }
  defaultId(): string {
    return (
      (this.db.prepare("SELECT value FROM settings WHERE key='default'").get() as { value: string } | undefined)
        ?.value ?? 'local'
    );
  }
  setDefault(id: string): void {
    const value = id === 'local' ? id : this.get(id).id;
    this.db
      .prepare("INSERT INTO settings VALUES ('default',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(value);
  }
  interruptRequests(): void {
    this.db.prepare("UPDATE requests SET state='interrupted' WHERE state='running'").run();
  }
  async once<T>(
    workspace: string,
    sender: string,
    id: string,
    input: unknown,
    operation: () => Promise<T>,
    validate?: () => void,
  ): Promise<T> {
    identifier(id);
    const hash = digest(JSON.stringify(input));
    const row = this.db
      .prepare('SELECT hash,state,result FROM requests WHERE workspace=? AND sender=? AND id=?')
      .get(workspace, sender, id) as { hash: string; state: string; result: string | null } | undefined;
    if (row) {
      if (row.hash !== hash) throw new Error('Request ID was reused with different input.');
      if (row.state === 'complete') return JSON.parse(row.result!);
      if (row.state === 'failed') throw new Error(JSON.parse(row.result!));
      if (row.state === 'expired')
        throw new Error('The previous request result has expired. The operation will not be repeated.');
      throw new Error(
        row.state === 'running'
          ? 'Request is still running; query its status.'
          : 'Request was interrupted; its outcome is unknown. It will not be repeated.',
      );
    }
    validate?.();
    this.prune();
    if ((this.db.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count >= 100000)
      throw new Error(
        'Workspace operation journal capacity reached. Re-pair a new workspace before accepting more operations.',
      );
    this.db
      .prepare('INSERT INTO requests VALUES (?,?,?,?,?,NULL,?)')
      .run(workspace, sender, id, hash, 'running', Date.now());
    try {
      const result = await operation();
      if (!this.closed) {
        const saved = JSON.stringify(result ?? null);
        const retain = Buffer.byteLength(saved) <= 8 * 1024 * 1024;
        this.db
          .prepare('UPDATE requests SET state=?,result=? WHERE workspace=? AND sender=? AND id=?')
          .run(retain ? 'complete' : 'expired', retain ? saved : null, workspace, sender, id);
      }
      return result;
    } catch (error) {
      if (!this.closed)
        this.db
          .prepare("UPDATE requests SET state='failed',result=? WHERE workspace=? AND sender=? AND id=?")
          .run(JSON.stringify(error instanceof Error ? error.message : 'Operation failed.'), workspace, sender, id);
      throw error;
    }
  }
  private readIdentity(id: string): PrivateIdentity {
    const file = path.join(this.directory, `${identifier(id)}.credentials.json`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0)
        throw new Error('Workspace credentials must be an owner-only regular file.');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }
  private writeIdentity(id: string, identity: PrivateIdentity): void {
    const target = path.join(this.directory, `${identifier(id)}.credentials.json`);
    const temp = `${target}.${randomId()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(identity));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}
