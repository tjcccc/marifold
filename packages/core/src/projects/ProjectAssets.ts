import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';

/**
 * Project assets (docs/projects.md#assets): files a project keeps for every
 * profile and session in it. A stored asset is content marifold keeps: each
 * save of a name adds a version, content is kept once per project as
 * `<project dir>/assets/<sha256>`, and the project's limit counts each
 * distinct content once, across all versions. A linked asset is a file or
 * folder on a workspace device, read live there and never counted.
 */

export const PROJECT_ASSETS_TABLE = 'marifold_project_assets';
export const PROJECT_ASSET_VERSIONS_TABLE = 'marifold_project_asset_versions';
export const DEFAULT_ASSET_LIMIT_BYTES = 100 * 1024 * 1024;
/** One version's cap. Guests read assets through the workspace bridge, whose
 * messages carry at most 40 MiB of base64. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;

interface ProjectAssetBase {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProjectAsset extends ProjectAssetBase {
  kind: 'stored';
  /** The latest version's number and content. */
  version: number;
  size: number;
  mediaType: string;
  sha256: string;
  /** The profile that saved the latest version; absent when the user did. */
  savedBy?: string;
  /** Runs whose outputs were saved as a version, so clients can mark them as kept. */
  runIds?: string[];
}

export interface LinkedProjectAsset extends ProjectAssetBase {
  kind: 'linked';
  /** The workspace device holding it; absent for the host (this device). */
  deviceId?: string;
  /** `~/…` (that device's home) or an absolute path there. */
  path: string;
}

export type ProjectAsset = StoredProjectAsset | LinkedProjectAsset;

export interface ProjectAssetVersion {
  version: number;
  size: number;
  mediaType: string;
  sha256: string;
  savedBy?: string;
  /** The run whose output this version is. */
  runId?: string;
  createdAt: string;
}

export interface ProjectAssetUsage {
  /** Distinct stored content, across every version. */
  usedBytes: number;
  limitBytes: number;
}

export interface ProjectAssetSave {
  name: string;
  data: Buffer;
  mediaType: string;
  /** Replaces the asset's description; omitted keeps it. */
  description?: string;
  savedBy?: string;
  runId?: string;
}

export interface ProjectAssetContent {
  path: string;
  name: string;
  version: number;
  size: number;
  mediaType: string;
  sha256: string;
}

/** What the project store lends its assets: its database, each project's
 * folder and limit, and its clock. */
export interface ProjectAssetsHost {
  read<T>(work: (db: Database.Database) => T): T;
  /** Runs `work` in one transaction. */
  write<T>(work: (db: Database.Database) => T): T;
  /** Throws PROJECT_NOT_FOUND for an unknown project. */
  assetLimit(db: Database.Database, projectId: string): number;
  projectDir(projectId: string): string | undefined;
  now(): Date;
}

export function ensureProjectAssetTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECT_ASSETS_TABLE} (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'stored',
      device_id TEXT,
      path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name COLLATE NOCASE)
    );
    CREATE TABLE IF NOT EXISTS ${PROJECT_ASSET_VERSIONS_TABLE} (
      asset_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      saved_by TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (asset_id, version)
    );
  `);
  // Databases from before linked assets.
  const columns = db.prepare(`PRAGMA table_info(${PROJECT_ASSETS_TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'kind')) {
    db.exec(`ALTER TABLE ${PROJECT_ASSETS_TABLE} ADD COLUMN kind TEXT NOT NULL DEFAULT 'stored'; ALTER TABLE ${PROJECT_ASSETS_TABLE} ADD COLUMN device_id TEXT; ALTER TABLE ${PROJECT_ASSETS_TABLE} ADD COLUMN path TEXT;`);
  }
}

/** Remove a deleted project's asset rows, inside its delete transaction; its
 * folder goes with the project's. */
export function deleteProjectAssetRows(db: Database.Database, projectId: string): void {
  db.prepare(`DELETE FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id IN (SELECT id FROM ${PROJECT_ASSETS_TABLE} WHERE project_id = ?)`).run(projectId);
  db.prepare(`DELETE FROM ${PROJECT_ASSETS_TABLE} WHERE project_id = ?`).run(projectId);
}

export class ProjectAssets {
  constructor(private readonly host: ProjectAssetsHost) {}

  /** Assets by name, with the project's usage. */
  list(projectId: string): { assets: ProjectAsset[]; usage: ProjectAssetUsage } {
    return this.host.read(db => {
      const limitBytes = this.host.assetLimit(db, projectId);
      const rows = db.prepare(`${LATEST_SELECT} WHERE a.project_id = ? ORDER BY a.name COLLATE NOCASE, a.id`).all(projectId) as AssetRow[];
      return { assets: rows.map(toAsset), usage: { usedBytes: usedBytes(db, projectId), limitBytes } };
    });
  }

  get(projectId: string, assetId: string): ProjectAsset | undefined {
    return this.host.read(db => {
      this.host.assetLimit(db, projectId);
      const row = db.prepare(`${LATEST_SELECT} WHERE a.project_id = ? AND a.id = ?`).get(projectId, assetId) as AssetRow | undefined;
      return row ? toAsset(row) : undefined;
    });
  }

  /** The asset with this name, ignoring case. */
  find(projectId: string, name: string): ProjectAsset | undefined {
    return this.host.read(db => {
      this.host.assetLimit(db, projectId);
      const row = db.prepare(`${LATEST_SELECT} WHERE a.project_id = ? AND a.name = ? COLLATE NOCASE`).get(projectId, name.trim()) as AssetRow | undefined;
      return row ? toAsset(row) : undefined;
    });
  }

  /** Every version, newest first. */
  versions(projectId: string, assetId: string): ProjectAssetVersion[] {
    return this.host.read(db => {
      this.existing(db, projectId, assetId);
      return (db.prepare(`SELECT * FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = ? ORDER BY version DESC`).all(assetId) as VersionRow[]).map(toVersion);
    });
  }

  /**
   * Save content under a name: a new asset, or a new version of the asset
   * already called that. Content equal to the latest version adds nothing.
   * The limit check and the rows commit together; the content is written
   * beside them first and renamed into place after, so a failed save leaves
   * no file and a stored row never lacks its content.
   */
  save(projectId: string, input: ProjectAssetSave): { asset: StoredProjectAsset; newVersion: boolean } {
    const name = validName(input.name, projectId);
    const mediaType = validMediaType(input.mediaType, projectId);
    const description = input.description === undefined ? undefined : validDescription(input.description, projectId);
    if (input.data.length > MAX_ASSET_BYTES) {
      throw MarifoldError.projectAssetLimit(projectId, `An asset is at most ${formatBytes(MAX_ASSET_BYTES)}; this one is ${formatBytes(input.data.length)}.`);
    }
    const dir = this.assetsDir(projectId);
    const sha256 = crypto.createHash('sha256').update(input.data).digest('hex');
    const blob = path.join(dir, sha256);
    let staged: string | undefined;
    if (!fs.existsSync(blob)) {
      fs.mkdirSync(dir, { recursive: true });
      staged = path.join(dir, `.${sha256}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(staged, input.data, { flag: 'wx' });
    }
    try {
      const saved = this.host.write(db => {
        const limitBytes = this.host.assetLimit(db, projectId);
        const at = this.host.now().toISOString();
        const existing = db.prepare(`${LATEST_SELECT} WHERE a.project_id = ? AND a.name = ? COLLATE NOCASE`).get(projectId, name) as AssetRow | undefined;
        if (existing?.kind === 'linked') { throw MarifoldError.projectInvalid(`'${existing.name}' is a linked asset; store this under another name.`, projectId); }
        const describe = (id: string) => {
          if (description !== undefined) { db.prepare(`UPDATE ${PROJECT_ASSETS_TABLE} SET description = ?, updated_at = ? WHERE id = ?`).run(description, at, id); }
        };
        if (existing && existing.sha256 === sha256 && existing.media_type === mediaType) {
          describe(existing.id);
          return { id: existing.id, newVersion: false };
        }
        if (!contentStored(db, projectId, sha256)) {
          const used = usedBytes(db, projectId);
          if (used + input.data.length > limitBytes) {
            throw MarifoldError.projectAssetLimit(projectId, `This project's assets would use ${formatBytes(used + input.data.length)} of its ${formatBytes(limitBytes)} limit. Remove assets or raise the limit in Project settings.`);
          }
        }
        const id = existing?.id ?? `asset_${crypto.randomBytes(6).toString('hex')}`;
        if (existing) {
          db.prepare(`UPDATE ${PROJECT_ASSETS_TABLE} SET updated_at = ? WHERE id = ?`).run(at, id);
          describe(id);
        } else {
          db.prepare(`INSERT INTO ${PROJECT_ASSETS_TABLE} (id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, projectId, name, description ?? null, at, at);
        }
        db.prepare(`INSERT INTO ${PROJECT_ASSET_VERSIONS_TABLE} (asset_id, version, sha256, size, media_type, saved_by, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, (existing?.version ?? 0) + 1, sha256, input.data.length, mediaType, input.savedBy ?? null, input.runId ?? null, at);
        return { id, newVersion: true };
      });
      if (staged) {
        fs.renameSync(staged, blob);
        staged = undefined;
      }
      return { asset: this.get(projectId, saved.id) as StoredProjectAsset, newVersion: saved.newVersion };
    } finally {
      if (staged) { fs.rmSync(staged, { force: true }); }
    }
  }

  /** A version's stored file (the latest when `version` is omitted). */
  content(projectId: string, assetId: string, version?: number): ProjectAssetContent {
    const found = this.host.read(db => {
      const asset = this.existing(db, projectId, assetId);
      if (asset.kind === 'linked') { throw MarifoldError.projectInvalid(`'${asset.name}' is linked, not stored: it is read on its device.`, projectId); }
      const row = version === undefined
        ? db.prepare(`SELECT * FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = ? ORDER BY version DESC LIMIT 1`).get(assetId) as VersionRow | undefined
        : db.prepare(`SELECT * FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = ? AND version = ?`).get(assetId, version) as VersionRow | undefined;
      if (!row) { throw MarifoldError.projectAssetNotFound(projectId, `${asset.name} version ${version}`); }
      return { asset, row };
    });
    const file = path.join(this.assetsDir(projectId), found.row.sha256);
    if (!fs.existsSync(file)) { throw MarifoldError.projectAssetNotFound(projectId, `${found.asset.name} (its stored file is missing)`); }
    return { path: file, name: found.asset.name, version: found.row.version, size: found.row.size, mediaType: found.row.media_type, sha256: found.row.sha256 };
  }

  /** Link a file or folder on a workspace device (`deviceId` absent: the host). */
  link(projectId: string, input: { deviceId?: string; path: string; name?: string; description?: string }): LinkedProjectAsset {
    const linkPath = validLinkPath(input.path, projectId);
    const name = validName(input.name ?? (linkPath === '~' ? 'home' : path.posix.basename(linkPath)), projectId);
    const description = input.description === undefined ? undefined : validDescription(input.description, projectId);
    const id = `asset_${crypto.randomBytes(6).toString('hex')}`;
    this.host.write(db => {
      this.host.assetLimit(db, projectId);
      const taken = db.prepare(`SELECT name, kind, device_id, path FROM ${PROJECT_ASSETS_TABLE} WHERE project_id = ? AND (name = ? COLLATE NOCASE OR (kind = 'linked' AND path = ? AND device_id IS ?))`)
        .get(projectId, name, linkPath, input.deviceId ?? null) as { name: string; kind: string } | undefined;
      if (taken) {
        throw MarifoldError.projectInvalid(taken.name.toLowerCase() === name.toLowerCase() ? `An asset named '${taken.name}' already exists.` : `This is already linked as '${taken.name}'.`, projectId);
      }
      const at = this.host.now().toISOString();
      db.prepare(`INSERT INTO ${PROJECT_ASSETS_TABLE} (id, project_id, name, description, kind, device_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, 'linked', ?, ?, ?, ?)`)
        .run(id, projectId, name, description ?? null, input.deviceId ?? null, linkPath, at, at);
    });
    return this.get(projectId, id) as LinkedProjectAsset;
  }

  /** Rename an asset or change its description (`null` clears it). */
  update(projectId: string, assetId: string, patch: { name?: string; description?: string | null }): ProjectAsset {
    const name = patch.name === undefined ? undefined : validName(patch.name, projectId);
    this.host.write(db => {
      this.existing(db, projectId, assetId);
      if (name !== undefined) {
        const taken = db.prepare(`SELECT 1 FROM ${PROJECT_ASSETS_TABLE} WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?`).get(projectId, name, assetId);
        if (taken) { throw MarifoldError.projectInvalid(`An asset named '${name}' already exists.`, projectId); }
        db.prepare(`UPDATE ${PROJECT_ASSETS_TABLE} SET name = ? WHERE id = ?`).run(name, assetId);
      }
      if (patch.description !== undefined) {
        db.prepare(`UPDATE ${PROJECT_ASSETS_TABLE} SET description = ? WHERE id = ?`)
          .run(patch.description === null ? null : validDescription(patch.description, projectId) ?? null, assetId);
      }
      db.prepare(`UPDATE ${PROJECT_ASSETS_TABLE} SET updated_at = ? WHERE id = ?`).run(this.host.now().toISOString(), assetId);
    });
    return this.get(projectId, assetId)!;
  }

  /** Delete an asset with every version, then any content no version uses. */
  delete(projectId: string, assetId: string): void {
    this.host.write(db => {
      this.existing(db, projectId, assetId);
      db.prepare(`DELETE FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = ?`).run(assetId);
      db.prepare(`DELETE FROM ${PROJECT_ASSETS_TABLE} WHERE id = ?`).run(assetId);
    });
    this.collect(projectId);
  }

  private collect(projectId: string): void {
    const dir = this.host.projectDir(projectId);
    if (!dir) { return; }
    const assetsDir = path.join(dir, 'assets');
    const used = this.host.read(db => new Set((db.prepare(`SELECT DISTINCT v.sha256 FROM ${PROJECT_ASSET_VERSIONS_TABLE} v JOIN ${PROJECT_ASSETS_TABLE} a ON a.id = v.asset_id WHERE a.project_id = ?`).all(projectId) as Array<{ sha256: string }>).map(row => row.sha256)));
    let files: string[];
    try { files = fs.readdirSync(assetsDir); } catch { return; }
    for (const file of files) {
      if (/^[0-9a-f]{64}$/.test(file) && !used.has(file)) { fs.rmSync(path.join(assetsDir, file), { force: true }); }
    }
  }

  private assetsDir(projectId: string): string {
    const dir = this.host.projectDir(projectId);
    if (!dir) { throw MarifoldError.projectInvalid('Project assets are not available here.', projectId); }
    return path.join(dir, 'assets');
  }

  private existing(db: Database.Database, projectId: string, assetId: string): AssetRow {
    this.host.assetLimit(db, projectId);
    const row = db.prepare(`${LATEST_SELECT} WHERE a.project_id = ? AND a.id = ?`).get(projectId, assetId) as AssetRow | undefined;
    if (!row) { throw MarifoldError.projectAssetNotFound(projectId, assetId); }
    return row;
  }
}

/** Human sizes for messages and manifests: "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** Each asset with its latest version (none for a linked one). */
const LATEST_SELECT = `SELECT a.*, v.version, v.sha256, v.size, v.media_type, v.saved_by,
  (SELECT group_concat(DISTINCT run_id) FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = a.id) AS run_ids FROM ${PROJECT_ASSETS_TABLE} a
  LEFT JOIN ${PROJECT_ASSET_VERSIONS_TABLE} v ON v.asset_id = a.id AND v.version = (SELECT MAX(version) FROM ${PROJECT_ASSET_VERSIONS_TABLE} WHERE asset_id = a.id)`;

interface AssetRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  kind: 'stored' | 'linked';
  device_id: string | null;
  path: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  sha256: string;
  size: number;
  media_type: string;
  saved_by: string | null;
  run_ids: string | null;
}

interface VersionRow {
  asset_id: string;
  version: number;
  sha256: string;
  size: number;
  media_type: string;
  saved_by: string | null;
  run_id: string | null;
  created_at: string;
}

function toAsset(row: AssetRow): ProjectAsset {
  const base = {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === 'linked') {
    return { ...base, kind: 'linked', ...(row.device_id ? { deviceId: row.device_id } : {}), path: row.path ?? '' };
  }
  return {
    ...base,
    kind: 'stored',
    version: row.version,
    size: row.size,
    mediaType: row.media_type,
    sha256: row.sha256,
    ...(row.saved_by ? { savedBy: row.saved_by } : {}),
    ...(row.run_ids ? { runIds: row.run_ids.split(',') } : {}),
  };
}

function toVersion(row: VersionRow): ProjectAssetVersion {
  return {
    version: row.version,
    size: row.size,
    mediaType: row.media_type,
    sha256: row.sha256,
    ...(row.saved_by ? { savedBy: row.saved_by } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
  };
}

function usedBytes(db: Database.Database, projectId: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(size), 0) AS used FROM (SELECT DISTINCT v.sha256, v.size FROM ${PROJECT_ASSET_VERSIONS_TABLE} v
    JOIN ${PROJECT_ASSETS_TABLE} a ON a.id = v.asset_id WHERE a.project_id = ?)`).get(projectId) as { used: number }).used;
}

function contentStored(db: Database.Database, projectId: string, sha256: string): boolean {
  return db.prepare(`SELECT 1 FROM ${PROJECT_ASSET_VERSIONS_TABLE} v JOIN ${PROJECT_ASSETS_TABLE} a ON a.id = v.asset_id WHERE a.project_id = ? AND v.sha256 = ?`).get(projectId, sha256) !== undefined;
}

function validName(value: string, projectId: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > NAME_MAX || /[\p{Cc}/\\]/u.test(name) || name === '.' || name === '..') {
    throw MarifoldError.projectInvalid(`An asset name is 1–${NAME_MAX} characters on one line, without / or \\.`, projectId);
  }
  return name;
}

function validDescription(value: string, projectId: string): string | undefined {
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length > DESCRIPTION_MAX) { throw MarifoldError.projectInvalid(`An asset description is at most ${DESCRIPTION_MAX} characters.`, projectId); }
  return description || undefined;
}

/** `~`, `~/…` or an absolute path, without `..`, normalized. */
function validLinkPath(value: string, projectId: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const home = raw === '~' || raw.startsWith('~/');
  const parts = (home ? raw.slice(1) : raw).split('/').filter(part => part !== '' && part !== '.');
  if (raw.length > 1000 || /\p{Cc}/u.test(raw) || (!home && !raw.startsWith('/')) || parts.includes('..') || (!home && parts.length === 0)) {
    throw MarifoldError.projectInvalid('A linked path is ~/… on its device, or an absolute path there, without "..".', projectId);
  }
  return home ? ['~', ...parts].join('/') : `/${parts.join('/')}`;
}

function validMediaType(value: string, projectId: string): string {
  const mediaType = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (mediaType.length > 200 || !/^[a-z0-9][\w.+-]*\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(mediaType)) {
    throw MarifoldError.projectInvalid(`Invalid media type: ${String(value).slice(0, 200)}`, projectId);
  }
  return mediaType;
}
