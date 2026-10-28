import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MarifoldError } from '../errors/MarifoldError';
import { ARTIFACT_ID, type ArtifactBundleFile, type ArtifactKind, bundleEntry, bundleMediaType, bundlePath, newArtifactId } from './ArtifactBundle';

/**
 * The artifact library (docs/artifacts.md): one store for every profile and
 * project, `artifacts.db` beside `items/<id>/v<n>/` bundles. A version is a
 * full, immutable copy, written into `staging/` and renamed into place before
 * its rows commit, so a failed save leaves nothing. Folders are rows, never
 * directories; deleting moves an artifact to Recently deleted for 30 days.
 */

export const ARTIFACT_LIMITS = {
  versionBytes: 25 * 1024 * 1024,
  versionFiles: 500,
  libraryBytes: 1024 * 1024 * 1024,
};
export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 500;
const NOTE_MAX = 300;
const FOLDER_NAME_MAX = 80;

export interface ArtifactFolder {
  id: string;
  name: string;
  sortOrder: number;
  keepLatest?: number;
  count: number;
  unread: number;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  description?: string;
  kind: ArtifactKind;
  folderId?: string;
  projectId?: string;
  currentVersion: number;
  createdBy?: string;
  sessionId?: string;
  runId?: string;
  scheduleId?: string;
  /** The run output (by id) that Save as artifact made this from. */
  sourceOutput?: string;
  /** The user has opened the current version. */
  seen: boolean;
  /** Set while in Recently deleted. */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  version: number;
  entry: string;
  fileCount: number;
  size: number;
  createdBy?: string;
  runId?: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactFileInfo {
  path: string;
  size: number;
  mediaType: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  versions: ArtifactVersion[];
  /** The current version's files. */
  files: ArtifactFileInfo[];
  entry: string;
}

/** Where a save came from, recorded for display and scope. */
export interface ArtifactOrigin {
  profile?: string;
  sessionId?: string;
  runId?: string;
  projectId?: string;
  scheduleId?: string;
  /** Save as artifact: the run output it was made from. */
  sourceOutput?: string;
}

export interface ArtifactCreateInput extends ArtifactOrigin {
  title: string;
  files: ArtifactBundleFile[];
  entry?: string;
  description?: string;
  note?: string;
  folderId?: string;
}

export interface ArtifactVersionInput {
  files: ArtifactBundleFile[];
  entry?: string;
  note?: string;
  profile?: string;
  runId?: string;
  title?: string;
}

export interface ArtifactListFilter {
  /** A folder id, or `null` for Unfiled. */
  folderId?: string | null;
  projectId?: string;
  profile?: string;
  sessionId?: string;
  ids?: readonly string[];
  unread?: boolean;
  /** Recently deleted instead of the live library. */
  deleted?: boolean;
  /** Title contains, case-insensitive. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ArtifactUpdate {
  title?: string;
  description?: string;
  /** A folder id, or `null` for Unfiled. */
  folderId?: string | null;
  seen?: boolean;
}

interface ArtifactRow {
  id: string;
  title: string;
  description: string | null;
  kind: ArtifactKind;
  category_id: string | null;
  project_id: string | null;
  current_version: number;
  created_by_profile: string | null;
  session_id: string | null;
  run_id: string | null;
  schedule_id: string | null;
  source_output: string | null;
  seen_at: string | null;
  touched_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  keep_latest INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  category_id TEXT,
  project_id TEXT,
  current_version INTEGER NOT NULL,
  created_by_profile TEXT,
  session_id TEXT,
  run_id TEXT,
  schedule_id TEXT,
  source_output TEXT,
  seen_at TEXT,
  touched_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_category ON artifacts(category_id);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  entry TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  size INTEGER NOT NULL,
  created_by_profile TEXT,
  run_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE IF NOT EXISTS artifact_files (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version, path)
);
`;

export class ArtifactLibrary {
  private database?: Database.Database;

  constructor(
    /** The library folder, `artifacts/` beside `sessions.db`. */
    readonly directory: string,
    private readonly options: { limits?: Partial<typeof ARTIFACT_LIMITS>; now?: () => Date } = {},
  ) {}

  private get limits(): typeof ARTIFACT_LIMITS {
    return { ...ARTIFACT_LIMITS, ...this.options.limits };
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** Opened on first use; leftovers from interrupted saves are removed then. */
  private get db(): Database.Database {
    if (this.database) { return this.database; }
    fs.mkdirSync(path.join(this.directory, 'items'), { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(this.directory, 'staging'), { recursive: true, force: true });
    const db = new Database(path.join(this.directory, 'artifacts.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    // Libraries made by v0.107.0 test builds predate this column.
    if (!(db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).some(column => column.name === 'source_output')) {
      db.exec('ALTER TABLE artifacts ADD COLUMN source_output TEXT');
    }
    this.database = db;
    return db;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────

  create(input: ArtifactCreateInput): ArtifactDetail {
    const title = text(input.title, 'title', TITLE_MAX, true)!;
    const description = text(input.description, 'description', DESCRIPTION_MAX);
    const note = text(input.note, 'note', NOTE_MAX);
    if (input.folderId !== undefined) { this.requireFolder(input.folderId); }
    const files = this.checkFiles(input.files);
    const { entry, kind } = bundleEntry(files, input.entry);
    let id = newArtifactId();
    while (this.row(id, true)) { id = newArtifactId(); }
    const now = this.now();
    this.writeVersion(id, 1, files, () => {
      this.db.prepare(`INSERT INTO artifacts (id, title, description, kind, category_id, project_id, current_version, created_by_profile, session_id, run_id, schedule_id, source_output, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, description ?? null, kind, input.folderId ?? null, input.projectId ?? null, input.profile ?? null, input.sessionId ?? null, input.runId ?? null, input.scheduleId ?? null, input.sourceOutput ?? null, now, now);
      this.insertVersion(id, 1, entry, files, { profile: input.profile, runId: input.runId, note }, now);
    });
    return this.get(id)!;
  }

  /** A new version from a profile's edit; its title may change with it. */
  addVersion(id: string, input: ArtifactVersionInput): ArtifactDetail {
    const row = this.requireLive(id);
    const note = text(input.note, 'note', NOTE_MAX);
    const title = input.title === undefined ? undefined : text(input.title, 'title', TITLE_MAX, true);
    const files = this.checkFiles(input.files);
    const { entry, kind } = bundleEntry(files, input.entry);
    const version = row.current_version + 1;
    const now = this.now();
    this.writeVersion(id, version, files, () => {
      this.insertVersion(id, version, entry, files, { profile: input.profile, runId: input.runId, note }, now);
      this.db.prepare('UPDATE artifacts SET current_version = ?, kind = ?, title = COALESCE(?, title), seen_at = NULL, touched_at = ?, updated_at = ? WHERE id = ?')
        .run(version, kind, title ?? null, now, now, id);
    });
    return this.get(id)!;
  }

  /** Makes an earlier version current by adding a copy of it as the newest. */
  restore(id: string, version: number, profile?: string): ArtifactDetail {
    this.requireLive(id);
    const source = this.versionRow(id, version);
    if (!source) { throw MarifoldError.artifactInvalid(`Artifact ${id} has no version ${version}.`); }
    const files = this.versionFiles(id, version).map(file => ({
      path: file.path,
      data: fs.readFileSync(this.filePath(id, version, file.path)),
    }));
    return this.addVersion(id, { files, entry: source.entry, profile, note: `Restored version ${version}` });
  }

  get(id: string): ArtifactDetail | undefined {
    const row = this.row(id, true);
    if (!row) { return undefined; }
    const versions = (this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version').all(id) as Array<Record<string, unknown>>)
      .map(versionFromRow);
    const current = versions.find(version => version.version === row.current_version);
    return {
      ...summaryFromRow(row),
      versions,
      entry: current?.entry ?? '',
      files: this.versionFiles(id, row.current_version).map(({ path: filePath, size, mediaType }) => ({ path: filePath, size, mediaType })),
    };
  }

  list(filter: ArtifactListFilter = {}): ArtifactSummary[] {
    const where: string[] = [filter.deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
    const params: unknown[] = [];
    if (filter.folderId === null) { where.push('category_id IS NULL'); }
    else if (filter.folderId !== undefined) { where.push('category_id = ?'); params.push(filter.folderId); }
    if (filter.projectId !== undefined) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.profile !== undefined) { where.push('created_by_profile = ?'); params.push(filter.profile); }
    if (filter.sessionId !== undefined) { where.push('session_id = ?'); params.push(filter.sessionId); }
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) { return []; }
      where.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.unread) { where.push('seen_at IS NULL'); }
    if (filter.query?.trim()) { where.push("title LIKE ? ESCAPE '\\'"); params.push(`%${filter.query.trim().replace(/[\\%_]/g, char => `\\${char}`)}%`); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const order = filter.deleted ? 'deleted_at DESC' : 'updated_at DESC';
    return (this.db.prepare(`SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY ${order}, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ArtifactRow[]).map(summaryFromRow);
  }

  update(id: string, update: ArtifactUpdate): ArtifactDetail {
    this.requireLive(id);
    const now = this.now();
    const sets: string[] = [];
    const params: unknown[] = [];
    const userChange = update.title !== undefined || update.description !== undefined || update.folderId !== undefined;
    if (update.title !== undefined) { sets.push('title = ?'); params.push(text(update.title, 'title', TITLE_MAX, true)); }
    if (update.description !== undefined) { sets.push('description = ?'); params.push(text(update.description, 'description', DESCRIPTION_MAX) ?? null); }
    if (update.folderId !== undefined) {
      if (update.folderId !== null) { this.requireFolder(update.folderId); }
      sets.push('category_id = ?');
      params.push(update.folderId);
    }
    if (update.seen !== undefined) { sets.push('seen_at = ?'); params.push(update.seen ? now : null); }
    if (sets.length === 0) { return this.get(id)!; }
    if (userChange) { sets.push('touched_at = ?', 'updated_at = ?'); params.push(now, now); }
    this.db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.get(id)!;
  }

  /** Moves an artifact to Recently deleted. */
  delete(id: string): void {
    this.requireLive(id);
    this.db.prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ?').run(this.now(), id);
  }

  undelete(id: string): ArtifactDetail {
    const row = this.row(id, true);
    if (!row?.deleted_at) { throw MarifoldError.artifactInvalid(`Artifact ${id} is not in Recently deleted.`); }
    const folder = row.category_id && this.folderRow(row.category_id) ? row.category_id : null;
    this.db.prepare('UPDATE artifacts SET deleted_at = NULL, category_id = ? WHERE id = ?').run(folder, id);
    return this.get(id)!;
  }

  /** Removes an artifact and every version for good. */
  purge(id: string): void {
    if (!this.row(id, true)) { throw notFound(id); }
    this.db.transaction(() => {
      for (const table of ['artifact_files', 'artifact_versions']) { this.db.prepare(`DELETE FROM ${table} WHERE artifact_id = ?`).run(id); }
      this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    })();
    fs.rmSync(path.join(this.directory, 'items', id), { recursive: true, force: true });
  }

  /** The live artifact this run output already became. With `content`, also
   * one of the run's artifacts whose first entry file is identical (saved before
   * outputs were recorded), which then records the output. */
  savedFromOutput(runId: string, outputId: string, content?: Buffer): ArtifactDetail | undefined {
    const recorded = this.db.prepare('SELECT id FROM artifacts WHERE run_id = ? AND source_output = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1').get(runId, outputId) as { id: string } | undefined;
    if (recorded) { return this.get(recorded.id); }
    if (!content) { return undefined; }
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const same = this.db.prepare(`SELECT a.id FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = 1
      JOIN artifact_files f ON f.artifact_id = a.id AND f.version = 1 AND f.path = v.entry
      WHERE a.run_id = ? AND a.source_output IS NULL AND a.deleted_at IS NULL AND f.sha256 = ? ORDER BY a.created_at LIMIT 1`).get(runId, sha256) as { id: string } | undefined;
    if (!same) { return undefined; }
    this.db.prepare('UPDATE artifacts SET source_output = ? WHERE id = ?').run(outputId, same.id);
    return this.get(same.id);
  }

  /** A deleted project's artifacts stay in the library, no longer attached to it. */
  detachProject(projectId: string): void {
    this.db.prepare('UPDATE artifacts SET project_id = NULL WHERE project_id = ?').run(projectId);
  }

  /** Purges what has been in Recently deleted longer than the retention. */
  purgeExpired(): number {
    const cutoff = new Date((this.options.now?.() ?? new Date()).getTime() - ARTIFACT_RETENTION_MS).toISOString();
    const expired = this.db.prepare('SELECT id FROM artifacts WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as Array<{ id: string }>;
    for (const { id } of expired) { this.purge(id); }
    return expired.length;
  }

  /** A version's file on disk, for serving. Undefined when it is not part of that version. */
  file(id: string, version: number, filePath: string): ArtifactFileInfo & { absolutePath: string } | undefined {
    if (!ARTIFACT_ID.test(id)) { return undefined; }
    let safe: string;
    try { safe = bundlePath(filePath); } catch { return undefined; }
    const row = this.db.prepare('SELECT path, size, media_type FROM artifact_files WHERE artifact_id = ? AND version = ? AND path = ?').get(id, version, safe) as { path: string; size: number; media_type: string } | undefined;
    if (!row) { return undefined; }
    return { path: row.path, size: row.size, mediaType: row.media_type, absolutePath: this.filePath(id, version, row.path) };
  }

  /** Bytes used by every version of every artifact, deleted ones included. */
  usage(): { usedBytes: number; limitBytes: number } {
    const used = (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM artifact_versions').get() as { used: number }).used;
    return { usedBytes: used, limitBytes: this.limits.libraryBytes };
  }

  /** Counts for the fixed folders: All, Unread, Unfiled, Recently deleted. */
  counts(): { all: number; unread: number; unfiled: number; deleted: number } {
    return this.db.prepare(`SELECT
      COALESCE(SUM(deleted_at IS NULL), 0) AS "all",
      COALESCE(SUM(deleted_at IS NULL AND seen_at IS NULL), 0) AS unread,
      COALESCE(SUM(deleted_at IS NULL AND category_id IS NULL), 0) AS unfiled,
      COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted
      FROM artifacts`).get() as { all: number; unread: number; unfiled: number; deleted: number };
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  folders(): ArtifactFolder[] {
    return (this.db.prepare(`SELECT c.*, COUNT(a.id) AS count, COALESCE(SUM(CASE WHEN a.id IS NOT NULL AND a.seen_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
      FROM artifact_categories c LEFT JOIN artifacts a ON a.category_id = c.id AND a.deleted_at IS NULL
      GROUP BY c.id ORDER BY c.sort_order, c.name COLLATE NOCASE`).all() as Array<Record<string, unknown>>)
      .map(row => ({
        id: String(row.id),
        name: String(row.name),
        sortOrder: Number(row.sort_order),
        ...(row.keep_latest !== null ? { keepLatest: Number(row.keep_latest) } : {}),
        count: Number(row.count),
        unread: Number(row.unread),
      }));
  }

  createFolder(name: string): ArtifactFolder {
    const clean = this.folderName(name);
    const now = this.now();
    const id = newArtifactId();
    const order = (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM artifact_categories').get() as { next: number }).next;
    this.db.prepare('INSERT INTO artifact_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, clean, order, now, now);
    return this.folders().find(folder => folder.id === id)!;
  }

  /** The folder with this name (case-insensitive), created when missing. */
  folderNamed(name: string): ArtifactFolder {
    const clean = name.trim();
    return this.folders().find(folder => folder.name.toLowerCase() === clean.toLowerCase()) ?? this.createFolder(clean);
  }

  updateFolder(id: string, update: { name?: string; sortOrder?: number; keepLatest?: number | null }): ArtifactFolder {
    this.requireFolder(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (update.name !== undefined) { sets.push('name = ?'); params.push(this.folderName(update.name, id)); }
    if (update.sortOrder !== undefined) {
      if (!Number.isSafeInteger(update.sortOrder)) { throw MarifoldError.artifactInvalid('sortOrder must be a whole number.'); }
      sets.push('sort_order = ?');
      params.push(update.sortOrder);
    }
    if (update.keepLatest !== undefined) {
      if (update.keepLatest !== null && (!Number.isSafeInteger(update.keepLatest) || update.keepLatest < 1)) {
        throw MarifoldError.artifactInvalid('keepLatest must be a positive whole number, or null.');
      }
      sets.push('keep_latest = ?');
      params.push(update.keepLatest);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE artifact_categories SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, this.now(), id);
    }
    return this.folders().find(folder => folder.id === id)!;
  }

  /** Deletes a folder; its artifacts become Unfiled. */
  deleteFolder(id: string): void {
    this.requireFolder(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE artifacts SET category_id = NULL WHERE category_id = ?').run(id);
      this.db.prepare('DELETE FROM artifact_categories WHERE id = ?').run(id);
    })();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private row(id: string, includeDeleted = false): ArtifactRow | undefined {
    if (!ARTIFACT_ID.test(id)) { return undefined; }
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return row && (includeDeleted || !row.deleted_at) ? row : undefined;
  }

  private requireLive(id: string): ArtifactRow {
    const row = this.row(id);
    if (!row) { throw notFound(id); }
    return row;
  }

  private folderRow(id: string): { id: string } | undefined {
    return this.db.prepare('SELECT id FROM artifact_categories WHERE id = ?').get(id) as { id: string } | undefined;
  }

  private requireFolder(id: string): void {
    if (!this.folderRow(id)) { throw MarifoldError.artifactInvalid(`Unknown artifact folder: ${id}.`); }
  }

  private folderName(name: string, except?: string): string {
    const clean = text(name, 'folder name', FOLDER_NAME_MAX, true)!;
    const taken = this.folders().some(folder => folder.id !== except && folder.name.toLowerCase() === clean.toLowerCase());
    if (taken) { throw MarifoldError.artifactInvalid(`A folder named "${clean}" already exists.`); }
    return clean;
  }

  private versionRow(id: string, version: number): ArtifactVersion | undefined {
    const row = this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(id, version) as Record<string, unknown> | undefined;
    return row ? versionFromRow(row) : undefined;
  }

  private versionFiles(id: string, version: number): Array<ArtifactFileInfo & { sha256: string }> {
    return (this.db.prepare('SELECT path, size, media_type, sha256 FROM artifact_files WHERE artifact_id = ? AND version = ? ORDER BY path').all(id, version) as Array<{ path: string; size: number; media_type: string; sha256: string }>)
      .map(row => ({ path: row.path, size: row.size, mediaType: row.media_type, sha256: row.sha256 }));
  }

  private filePath(id: string, version: number, filePath: string): string {
    return path.join(this.directory, 'items', id, `v${version}`, ...filePath.split('/'));
  }

  /** Validated, de-duplicated files within the per-version and library limits. */
  private checkFiles(input: readonly ArtifactBundleFile[]): ArtifactBundleFile[] {
    if (!Array.isArray(input) || input.length === 0) { throw MarifoldError.artifactInvalid('An artifact needs at least one file.'); }
    const limits = this.limits;
    if (input.length > limits.versionFiles) {
      throw MarifoldError.artifactLimit(`An artifact version holds at most ${limits.versionFiles} files; this one has ${input.length}.`);
    }
    const seen = new Set<string>();
    const files = input.map(file => {
      const safe = bundlePath(file.path);
      const key = safe.toLowerCase();
      if (seen.has(key)) { throw MarifoldError.artifactInvalid(`The bundle has "${safe}" twice.`); }
      seen.add(key);
      return { path: safe, data: file.data };
    });
    const size = files.reduce((total, file) => total + file.data.length, 0);
    if (size > limits.versionBytes) {
      throw MarifoldError.artifactLimit(`An artifact version is at most ${megabytes(limits.versionBytes)}; this one is ${megabytes(size)}.`);
    }
    const { usedBytes } = this.usage();
    if (usedBytes + size > limits.libraryBytes) {
      throw MarifoldError.artifactLimit(`The artifact library is limited to ${megabytes(limits.libraryBytes)} and uses ${megabytes(usedBytes)}; this version needs ${megabytes(size)}. Empty Recently deleted or delete old artifacts to make room.`);
    }
    return files;
  }

  /** Stages the files, renames them into place, then commits the rows; any
   * failure removes what was written. */
  private writeVersion(id: string, version: number, files: readonly ArtifactBundleFile[], commit: () => void): void {
    const staging = path.join(this.directory, 'staging', crypto.randomBytes(8).toString('hex'));
    const target = path.join(this.directory, 'items', id, `v${version}`);
    if (fs.existsSync(target)) { throw MarifoldError.artifactInvalid(`Artifact ${id} already has version ${version}.`); }
    let renamed = false;
    try {
      for (const file of files) {
        const destination = path.join(staging, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(destination, file.data, { mode: 0o600, flag: 'wx' });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(staging, target);
      renamed = true;
      this.db.transaction(commit)();
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (renamed) { fs.rmSync(version === 1 ? path.dirname(target) : target, { recursive: true, force: true }); }
      throw error;
    }
  }

  private insertVersion(id: string, version: number, entry: string, files: readonly ArtifactBundleFile[], origin: { profile?: string; runId?: string; note?: string }, now: string): void {
    const size = files.reduce((total, file) => total + file.data.length, 0);
    this.db.prepare('INSERT INTO artifact_versions (artifact_id, version, entry, file_count, size, created_by_profile, run_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, version, entry, files.length, size, origin.profile ?? null, origin.runId ?? null, origin.note ?? null, now);
    const insert = this.db.prepare('INSERT INTO artifact_files (artifact_id, version, path, size, media_type, sha256) VALUES (?, ?, ?, ?, ?, ?)');
    for (const file of files) {
      insert.run(id, version, file.path, file.data.length, bundleMediaType(file.path), crypto.createHash('sha256').update(file.data).digest('hex'));
    }
  }
}

function summaryFromRow(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    kind: row.kind,
    ...(row.category_id ? { folderId: row.category_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    currentVersion: row.current_version,
    ...(row.created_by_profile ? { createdBy: row.created_by_profile } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.schedule_id ? { scheduleId: row.schedule_id } : {}),
    ...(row.source_output ? { sourceOutput: row.source_output } : {}),
    seen: row.seen_at !== null,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row: Record<string, unknown>): ArtifactVersion {
  return {
    version: Number(row.version),
    entry: String(row.entry),
    fileCount: Number(row.file_count),
    size: Number(row.size),
    ...(row.created_by_profile ? { createdBy: String(row.created_by_profile) } : {}),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    ...(row.note ? { note: String(row.note) } : {}),
    createdAt: String(row.created_at),
  };
}

/** Single-line text within a length, undefined when blank (an error when required). */
function text(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) { throw MarifoldError.artifactInvalid(`An artifact ${label} is required.`); }
    return undefined;
  }
  if (typeof value !== 'string') { throw MarifoldError.artifactInvalid(`The artifact ${label} must be text.`); }
  // One line: titles reach run instructions and `@[title]` mentions.
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) {
    if (required) { throw MarifoldError.artifactInvalid(`An artifact ${label} is required.`); }
    return undefined;
  }
  if (clean.length > max) { throw MarifoldError.artifactInvalid(`The artifact ${label} is at most ${max} characters.`); }
  return clean;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function notFound(id: string): MarifoldError {
  return MarifoldError.libraryArtifactNotFound(id);
}
