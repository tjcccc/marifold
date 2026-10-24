import type { PublicIdentity } from '@marifold/workspace-protocol';

export interface HostRegistration {
  workspaceId: string;
  hostDeviceId: string;
  host: PublicIdentity;
}
export interface InboxEntry {
  id: string;
  packet: string;
}
/** The synchronous SQLite surface shared by `node:sqlite` and Durable Object storage. */
export interface Sql {
  run(query: string, ...params: Array<string | number>): void;
  all(query: string, ...params: Array<string | number>): Array<Record<string, unknown>>;
}
export const INBOX_LIMIT = 128;
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS hosts (workspace TEXT PRIMARY KEY, registration TEXT NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS revocations (workspace TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (workspace, device)) WITHOUT ROWID',
  // seq orders replay; token is the random delivery ID the recipient acknowledges.
  'CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY, token TEXT NOT NULL, workspace TEXT NOT NULL, device TEXT NOT NULL, packet TEXT NOT NULL, expires INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS inbox_recipient ON inbox (workspace, device)',
];

/** Durable relay state: host registrations, revocations, and each recipient's unacknowledged frames. */
export class RelayStore {
  constructor(private readonly sql: Sql) {
    for (const statement of SCHEMA) { sql.run(statement); }
  }
  host(workspace: string): HostRegistration | undefined {
    const row = this.sql.all('SELECT registration FROM hosts WHERE workspace = ?', workspace)[0];
    return row ? (JSON.parse(String(row.registration)) as HostRegistration) : undefined;
  }
  /** Registers a workspace once; repeating the identical registration is accepted. */
  register(host: HostRegistration): void {
    const text = JSON.stringify(host);
    this.sql.run('INSERT OR IGNORE INTO hosts (workspace, registration) VALUES (?, ?)', host.workspaceId, text);
    const row = this.sql.all('SELECT registration FROM hosts WHERE workspace = ?', host.workspaceId)[0];
    if (row?.registration !== text) { throw new Error('Workspace already registered.'); }
  }
  revoked(workspace: string, device: string): boolean {
    return this.sql.all('SELECT 1 FROM revocations WHERE workspace = ? AND device = ?', workspace, device).length > 0;
  }
  revoke(workspace: string, device: string): void {
    this.sql.run('INSERT OR IGNORE INTO revocations (workspace, device) VALUES (?, ?)', workspace, device);
  }
  /** Unexpired frames stored for one recipient. */
  count(workspace: string, device: string, now: number): number {
    return Number(
      this.sql.all('SELECT count(*) AS n FROM inbox WHERE workspace = ? AND device = ? AND expires >= ?', workspace, device, now)[0]?.n ?? 0,
    );
  }
  /** Stores a frame until its recipient acknowledges it or it expires. */
  insert(id: string, workspace: string, device: string, packet: string, expires: number): void {
    this.sql.run(
      'INSERT INTO inbox (token, workspace, device, packet, expires) VALUES (?, ?, ?, ?, ?)',
      id,
      workspace,
      device,
      packet,
      expires,
    );
  }
  /** Unexpired frames for one recipient, oldest first. */
  pending(workspace: string, device: string, now: number): InboxEntry[] {
    return this.sql
      .all('SELECT token, packet FROM inbox WHERE workspace = ? AND device = ? AND expires >= ? ORDER BY seq', workspace, device, now)
      .map((row) => ({ id: String(row.token), packet: String(row.packet) }));
  }
  ack(workspace: string, device: string, id: string): void {
    this.sql.run('DELETE FROM inbox WHERE workspace = ? AND device = ? AND token = ?', workspace, device, id);
  }
  purge(now: number): void {
    this.sql.run('DELETE FROM inbox WHERE expires < ?', now);
  }
}
