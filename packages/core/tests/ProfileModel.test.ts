import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileManager } from '../src/profiles/ProfileManager';
import { ProfileResolver } from '../src/profiles/ProfileResolver';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function profile(toml: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-profile-model-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 'INSTRUCTIONS.md'), 'P');
  fs.writeFileSync(path.join(root, 'p', 'profile.toml'), toml);
  return { root, file: path.join(root, 'p', 'profile.toml') };
}
const settings = (root: string) => new ProfileResolver(root).loadSettings('p');

describe('profile model setting', () => {
  it('reads "provider/model" split at the first slash, and "default"', () => {
    expect(settings(profile('model = "ollama/maternion/hy-mt2:1.8b"\n').root)).toMatchObject({ provider: 'ollama', model: 'maternion/hy-mt2:1.8b', modelSetting: 'pinned' });
    const followed = settings(profile('model = "default"\n').root);
    expect(followed).toMatchObject({ modelSetting: 'default' });
    expect(followed.provider).toBeUndefined();
  });

  it('rejects a model without a provider and a provider without a model', () => {
    expect(() => settings(profile('model = "gpt-5.6-sol"\n').root)).toThrow(/"provider\/model".*or "default"/);
    expect(() => settings(profile('provider = "chatgpt"\nmodel = "default"\n').root)).toThrow(/provider without a model/);
  });

  it('migrates the older pair and drops the retired think key in one pass, keeping comments and tables, with one backup', () => {
    const original = '# my notes\ndisplay_name = "X"\nprovider = "chatgpt"\nmodel = "gpt-5.6-sol"\nthink = true\n\n[agent]\nmax_iterations = 9\n';
    const { root, file } = profile(original);
    const result = new ProfileManager(root).migrateProfileSettings('p');
    expect(result).toMatchObject({ status: 'migrated', value: 'chatgpt/gpt-5.6-sol', removedThink: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('# my notes\ndisplay_name = "X"\nmodel = "chatgpt/gpt-5.6-sol"\n\n[agent]\nmax_iterations = 9\n');
    expect(fs.readFileSync(result.backupPath!, 'utf-8')).toBe(original);
    expect(settings(root)).toMatchObject({ provider: 'chatgpt', model: 'gpt-5.6-sol', modelSetting: 'pinned', agent: { maxIterations: 9 } });
    expect(settings(root).legacyThink).toBeUndefined();
    expect(new ProfileManager(root).migrateProfileSettings('p').status).toBe('unchanged');
  });

  it('writes model = "default" as a top-level key ahead of any table', () => {
    const { root, file } = profile('memories = false\n\n[agent]\nmax_iterations = 9\n');
    expect(new ProfileManager(root).migrateProfileSettings('p')).toMatchObject({ status: 'migrated', value: 'default' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('memories = false\n\nmodel = "default"\n\n[agent]\nmax_iterations = 9\n');
    expect(settings(root)).toMatchObject({ modelSetting: 'default', memories: false, agent: { maxIterations: 9 } });
  });

  it('removes a leftover think key from an otherwise current profile, and reports it until then', () => {
    const { root, file } = profile('model = "default"\nthink = false\n');
    expect(settings(root)).toMatchObject({ modelSetting: 'default', legacyThink: false });
    expect(new ProfileManager(root).migrateProfileSettings('p')).toMatchObject({ status: 'migrated', removedThink: false });
    expect(fs.readFileSync(file, 'utf-8')).toBe('model = "default"\n');
  });
});
