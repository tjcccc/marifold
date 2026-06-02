import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileResolver } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProfileResolver', () => {
  it('loads priests-style profile directories', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Custom');

    const profile = new ProfileResolver(root).load('default');

    expect(profile.identity).toBe('Identity');
    expect(profile.rules).toBe('Rules');
    expect(profile.custom).toBe('Custom');
  });

  it('loads profile provider/model overrides from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'coder');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Coder');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\n');

    const settings = new ProfileResolver(root).loadSettings('coder');

    expect(settings).toEqual({ provider: 'ollama', model: 'codellama' });
  });

  it('returns the built-in default profile when no default profile exists', () => {
    const root = tempDir();

    const profile = new ProfileResolver(root).load('default');
    const list = new ProfileResolver(root).list();

    expect(profile.name).toBe('default');
    expect(list).toEqual([{ name: 'default', source: 'built-in' }]);
  });
});
