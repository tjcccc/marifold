import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';

/** A skill source read on one device and carried to the host as bytes. */
export interface SkillBundle {
  files: Array<{ path: string; data: string }>;
}

export const MAX_SKILL_BUNDLE_FILES = 100;
// The largest real skills are about 300 KB; 2 MB stays well inside the 120-second
// executor deadline on a slow bridge (a live 3 MB burst took 54 seconds).
export const MAX_SKILL_BUNDLE_BYTES = 2 * 1024 * 1024;
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/**
 * Read a skill source (a Markdown file or a folder containing SKILL.md) into a
 * bounded bundle. Only regular files are read; symlinks are refused so a
 * bundle can't reach outside the folder the caller vetted.
 */
export function readSkillBundle(source: string): SkillBundle {
  const stat = lstatOrThrow(source);
  if (stat.isFile()) {
    if (!/\.md$/i.test(source)) {
      throw MarifoldError.skillInvalid(`Skill source must be a Markdown file or folder: ${source}`);
    }
    assertSize(stat.size);
    return { files: [{ path: 'SKILL.md', data: fs.readFileSync(source).toString('base64') }] };
  }
  if (!stat.isDirectory()) {
    throw MarifoldError.skillInvalid(`Skill source must be a Markdown file or folder: ${source}`);
  }
  const files: SkillBundle['files'] = [];
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw MarifoldError.skillInvalid(`Skill sources cannot contain symlinks: ${relative}`);
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) { walk(full, relative); }
        continue;
      }
      if (!entry.isFile()) { continue; }
      if (files.length >= MAX_SKILL_BUNDLE_FILES) {
        throw MarifoldError.skillInvalid(`Skill source has more than ${MAX_SKILL_BUNDLE_FILES} files.`);
      }
      total += fs.statSync(full).size;
      assertSize(total);
      files.push({ path: relative, data: fs.readFileSync(full).toString('base64') });
    }
  };
  walk(source, '');
  if (!files.some(file => file.path === 'SKILL.md')) {
    throw MarifoldError.skillInvalid(`Skill folder has no SKILL.md: ${source}`);
  }
  return { files };
}

/**
 * Write a bundle received from another device into a fresh temporary folder
 * and return it. The bundle is untrusted: paths and sizes are checked again.
 * The caller removes the folder with `fs.rmSync(dir, { recursive: true })`.
 */
export function stageSkillBundle(value: unknown): string {
  const files = bundleFiles(value);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skill-source-'));
  try {
    for (const file of files) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function bundleFiles(value: unknown): Array<{ path: string; bytes: Buffer }> {
  const files = (value as SkillBundle | undefined)?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SKILL_BUNDLE_FILES) {
    throw MarifoldError.skillInvalid('The source device returned an invalid skill bundle.');
  }
  const seen = new Set<string>();
  let total = 0;
  return files.map((file) => {
    if (typeof file?.path !== 'string' || typeof file.data !== 'string') {
      throw MarifoldError.skillInvalid('The source device returned an invalid skill bundle.');
    }
    const relative = safeRelativePath(file.path);
    if (seen.has(relative)) { throw MarifoldError.skillInvalid(`Duplicate bundle path '${file.path}'.`); }
    seen.add(relative);
    const bytes = Buffer.from(file.data, 'base64');
    total += bytes.length;
    assertSize(total);
    return { path: relative, bytes };
  });
}

function safeRelativePath(value: string): string {
  const parts = value.split('/');
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    parts.some(part => part === '' || part === '.' || part === '..')
  ) {
    throw MarifoldError.skillInvalid(`Unsafe bundle path '${value}'.`);
  }
  return parts.join(path.sep);
}

function assertSize(bytes: number): void {
  if (bytes > MAX_SKILL_BUNDLE_BYTES) {
    throw MarifoldError.skillInvalid(`Skill source exceeds ${MAX_SKILL_BUNDLE_BYTES / (1024 * 1024)} MB.`);
  }
}

function lstatOrThrow(source: string): fs.Stats {
  try {
    return fs.lstatSync(source);
  } catch {
    throw MarifoldError.skillInvalid(`Skill not found: ${source}`);
  }
}
