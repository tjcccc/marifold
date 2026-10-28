import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleEntry, bundlePath } from '../src/artifacts/ArtifactBundle';
import { ARTIFACT_LIMITS, ArtifactLibrary } from '../src/artifacts/ArtifactLibrary';

// The artifact library store (docs/artifacts.md#storage).

const libraries: ArtifactLibrary[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const library of libraries.splice(0)) { library.close(); }
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function setup(options: ConstructorParameters<typeof ArtifactLibrary>[1] = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-artifacts-'));
  dirs.push(dir);
  const library = new ArtifactLibrary(path.join(dir, 'artifacts'), options);
  libraries.push(library);
  return library;
}

const file = (filePath: string, text: string) => ({ path: filePath, data: Buffer.from(text) });

describe('artifact bundles', () => {
  it('refuses paths that could leave the bundle', () => {
    for (const bad of ['../x.html', 'a/../../x', '/etc/passwd', 'a\\b.html', 'C:x.html', '.git/config', 'a//b.html', 'a/b\u0000.html', `${'a/'.repeat(8)}x.html`]) {
      expect(() => bundlePath(bad), bad).toThrow();
    }
    expect(bundlePath(' assets/logo.png ')).toBe('assets/logo.png');
  });

  it('picks the entry file and kind', () => {
    expect(bundleEntry([file('index.html', ''), file('app.js', '')])).toEqual({ entry: 'index.html', kind: 'html' });
    expect(bundleEntry([file('report.md', '')])).toEqual({ entry: 'report.md', kind: 'markdown' });
    expect(() => bundleEntry([file('a.html', ''), file('b.html', '')])).toThrow(/entry/);
    expect(() => bundleEntry([file('data.json', '')])).toThrow(/\.html or \.md/);
  });
});

describe('ArtifactLibrary', () => {
  it('saves a bundle as version 1 and serves only its own files', () => {
    const library = setup();
    const saved = library.create({ title: 'AI News', files: [file('index.html', '<h1>hi</h1>'), file('css/site.css', 'h1{}')], profile: 'default', sessionId: 's1' });
    expect(saved).toMatchObject({ kind: 'html', entry: 'index.html', currentVersion: 1, createdBy: 'default', seen: false });
    expect(saved.files.map(entry => entry.path)).toEqual(['css/site.css', 'index.html']);
    const css = library.file(saved.id, 1, 'css/site.css');
    expect(css?.mediaType).toBe('text/css; charset=utf-8');
    expect(fs.readFileSync(css!.absolutePath, 'utf8')).toBe('h1{}');
    expect(library.file(saved.id, 1, '../artifacts.db')).toBeUndefined();
    expect(library.file(saved.id, 2, 'index.html')).toBeUndefined();
  });

  it('refuses a bundle naming one file twice', () => {
    const library = setup();
    expect(() => library.create({ title: 'x', files: [file('index.html', ''), file('INDEX.html', '')] })).toThrow(/twice/);
  });

  it('enforces the version and library limits', () => {
    const library = setup({ limits: { versionBytes: 10, versionFiles: 2, libraryBytes: 15 } });
    expect(() => library.create({ title: 'x', files: [file('index.html', '12345678901')] })).toThrow(/at most/);
    expect(() => library.create({ title: 'x', files: [file('index.html', ''), file('a.css', ''), file('b.css', '')] })).toThrow(/at most 2 files/);
    library.create({ title: 'a', files: [file('index.html', '1234567890')] });
    expect(() => library.create({ title: 'b', files: [file('index.html', '123456')] })).toThrow(/limited to/);
    expect(ARTIFACT_LIMITS.versionFiles).toBe(500);
  });

  it('leaves nothing behind when a version fails to commit', () => {
    const library = setup();
    const saved = library.create({ title: 'x', files: [file('index.md', 'one')] });
    // A conflicting row makes the transaction fail after the files are renamed into place.
    const db = new Database(path.join(library.directory, 'artifacts.db'));
    db.prepare("INSERT INTO artifact_versions (artifact_id, version, entry, file_count, size, created_at) VALUES (?, 2, 'x', 0, 0, 'now')").run(saved.id);
    db.close();
    expect(() => library.addVersion(saved.id, { files: [file('index.md', 'two')] })).toThrow();
    expect(fs.existsSync(path.join(library.directory, 'items', saved.id, 'v2'))).toBe(false);
    expect(fs.readdirSync(path.join(library.directory, 'staging'))).toEqual([]);
    expect(library.get(saved.id)?.currentVersion).toBe(1);
  });

  it('adds versions, marks them unread, and restores an old one as the newest', () => {
    const library = setup();
    const saved = library.create({ title: 'Report', files: [file('index.md', 'one')] });
    library.update(saved.id, { seen: true });
    const second = library.addVersion(saved.id, { files: [file('index.md', 'two')], note: 'edit', title: 'Report v2' });
    expect(second).toMatchObject({ currentVersion: 2, title: 'Report v2', seen: false });
    const restored = library.restore(saved.id, 1, 'default');
    expect(restored.currentVersion).toBe(3);
    expect(restored.versions[restored.versions.length - 1]).toMatchObject({ version: 3, note: 'Restored version 1', createdBy: 'default' });
    expect(fs.readFileSync(library.file(saved.id, 3, 'index.md')!.absolutePath, 'utf8')).toBe('one');
  });

  it('deletes to Recently deleted, undeletes, and purges after 30 days', () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const library = setup({ now: () => now });
    const saved = library.create({ title: 'x', files: [file('index.md', 'x')] });
    library.delete(saved.id);
    expect(library.list()).toEqual([]);
    expect(library.list({ deleted: true }).map(item => item.id)).toEqual([saved.id]);
    expect(() => library.update(saved.id, { title: 'y' })).toThrow(/not found/);
    library.undelete(saved.id);
    expect(library.list().map(item => item.id)).toEqual([saved.id]);

    library.delete(saved.id);
    now = new Date('2026-10-30T00:00:00Z');
    expect(library.purgeExpired()).toBe(0);
    now = new Date('2026-11-01T00:00:01Z');
    expect(library.purgeExpired()).toBe(1);
    expect(library.get(saved.id)).toBeUndefined();
    expect(fs.existsSync(path.join(library.directory, 'items', saved.id))).toBe(false);
  });

  it('keeps folders as metadata; deleting one leaves its artifacts Unfiled', () => {
    const library = setup();
    const news = library.createFolder('AI News');
    expect(() => library.createFolder('ai news')).toThrow(/already exists/);
    expect(library.folderNamed('AI NEWS').id).toBe(news.id);
    const filed = library.create({ title: 'Today', files: [file('index.md', 'x')], folderId: news.id });
    library.create({ title: 'Loose', files: [file('index.md', 'x')] });
    expect(library.folders()).toMatchObject([{ name: 'AI News', count: 1, unread: 1 }]);
    expect(library.list({ folderId: null }).map(item => item.title)).toEqual(['Loose']);

    library.deleteFolder(news.id);
    expect(library.folders()).toEqual([]);
    expect(library.get(filed.id)?.folderId).toBeUndefined();
    expect(library.list({ folderId: null })).toHaveLength(2);
  });

  it('clears interrupted saves when it opens', () => {
    const library = setup();
    library.create({ title: 'x', files: [file('index.md', 'x')] });
    library.close();
    fs.mkdirSync(path.join(library.directory, 'staging', 'leftover'), { recursive: true });
    expect(library.list()).toHaveLength(1);
    expect(fs.existsSync(path.join(library.directory, 'staging', 'leftover'))).toBe(false);
  });

  it('adds the source-output column to an older library and finds what an output became', () => {
    const library = setup();
    library.create({ title: 'old', files: [file('index.md', '# old')] });
    library.close();
    const raw = new Database(path.join(library.directory, 'artifacts.db'));
    raw.exec('ALTER TABLE artifacts DROP COLUMN source_output');
    raw.close();
    const saved = library.create({ title: 'page', files: [file('page.html', '<p>')], runId: 'run_1', sourceOutput: 'a'.repeat(24) });
    expect(library.savedFromOutput('run_1', 'a'.repeat(24))?.id).toBe(saved.id);
    library.delete(saved.id);
    expect(library.savedFromOutput('run_1', 'a'.repeat(24))).toBeUndefined();
    // One saved before outputs were recorded is found by its identical entry file, and recorded.
    const earlier = library.create({ title: 'Test page', files: [file('index.html', '<h1>same</h1>'), file('a.css', '')], runId: 'run_2' });
    expect(library.savedFromOutput('run_2', 'b'.repeat(24))).toBeUndefined();
    expect(library.savedFromOutput('run_2', 'b'.repeat(24), Buffer.from('<h1>other</h1>'))).toBeUndefined();
    expect(library.savedFromOutput('run_2', 'b'.repeat(24), Buffer.from('<h1>same</h1>'))?.id).toBe(earlier.id);
    expect(library.get(earlier.id)?.sourceOutput).toBe('b'.repeat(24));
  });
});
