import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/util/atomicWrite';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

it('replaces a file in one step, keeping its mode and a symlinked location', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-atomic-'));
  dirs.push(dir);
  const real = path.join(dir, 'dotfiles', 'config.toml');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, 'old = true\n', { mode: 0o600 });
  const link = path.join(dir, 'config.toml');
  fs.symlinkSync(real, link);
  // A reader holding the old file keeps reading complete old content.
  const reader = fs.openSync(link, 'r');

  writeFileAtomic(link, 'new = true\n');

  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(real, 'utf-8')).toBe('new = true\n');
  expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(reader, 'utf-8')).toBe('old = true\n');
  fs.closeSync(reader);
  expect(fs.readdirSync(path.dirname(real))).toEqual(['config.toml']);

  const fresh = path.join(dir, 'fresh.toml');
  writeFileAtomic(fresh, 'created = true\n');
  expect(fs.readFileSync(fresh, 'utf-8')).toBe('created = true\n');
});
