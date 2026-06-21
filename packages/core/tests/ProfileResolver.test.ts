import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileResolver, ProfileManager } from '../src';

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

    expect(settings).toEqual({ provider: 'ollama', model: 'codellama', memories: true });
  });

  it('loads profile memory enablement from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'tool');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Formatter');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\n');

    const settings = new ProfileResolver(root).loadSettings('tool');

    expect(settings).toEqual({ memories: false });
  });

  it('shows profile file details and settings', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Writer identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Writer rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Writer custom');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'provider = "ollama"\nmodel = "gemma4:e4b"\n');

    const detail = new ProfileResolver(root).detail('writer');

    expect(detail.name).toBe('writer');
    expect(detail.settings).toEqual({ provider: 'ollama', model: 'gemma4:e4b', memories: true });
    expect(detail.files.profile.content).toBe('Writer identity');
    expect(detail.files.rules.content).toBe('Writer rules');
    expect(detail.files.custom.content).toBe('Writer custom');
  });

  it('loads the profile default mode from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'reader');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = true\nmode = "chat"\n');

    const settings = new ProfileResolver(root).loadSettings('reader');

    expect(settings.mode).toBe('chat');
  });

  it('rejects an invalid profile mode', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'broken');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'mode = "wizard"\n');

    expect(() => new ProfileResolver(root).loadSettings('broken')).toThrow(/invalid mode/i);
  });

  it('persists a default mode via ProfileManager and preserves other keys', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'coder');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\nprovider = "ollama"\nmodel = "codellama"\n');

    const result = new ProfileManager(root).setMode('coder', 'chat');
    const settings = new ProfileResolver(root).loadSettings('coder');

    expect(result.mode).toBe('chat');
    expect(settings).toEqual({ provider: 'ollama', model: 'codellama', memories: false, mode: 'chat' });
  });

  it('returns the built-in default profile when no default profile exists', () => {
    const root = tempDir();

    const profile = new ProfileResolver(root).load('default');
    const list = new ProfileResolver(root).list();

    expect(profile.name).toBe('default');
    expect(list).toEqual([{ name: 'default', source: 'built-in' }]);
  });
});
