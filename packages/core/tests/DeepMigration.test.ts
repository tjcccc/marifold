import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSkillApp } from '../src/app/SkillAppCompiler';
import { legacyDefaultThink, legacyThinkApps, migrateAppThink, migrateDefaultThink } from '../src/config/DeepMigration';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-deep-'));
  dirs.push(dir);
  return dir;
}

describe('think → deep migration', () => {
  it('renames [default] think only, with a backup', () => {
    const configPath = path.join(tempDir(), 'config.toml');
    const original = '[default]\nprovider = "ollama"\nthink = true\n\n[channel.telegram]\nthink = "not ours"\n';
    fs.writeFileSync(configPath, original);
    expect(legacyDefaultThink(configPath)).toBe(true);
    const backupPath = migrateDefaultThink(configPath)!;
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[default]\nprovider = "ollama"\ndeep = true\n\n[channel.telegram]\nthink = "not ours"\n');
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
    expect(legacyDefaultThink(configPath)).toBeUndefined();
  });

  it('renames think: options in installed apps, leaving prose alone, so they compile again', () => {
    const appsDir = tempDir();
    const example = fs.readFileSync(path.join(__dirname, '../../../examples/apps/translator/skillapp.ts'), 'utf-8');
    const template = path.join(appsDir, 'translator', 'skillapp.ts');
    fs.mkdirSync(path.dirname(template));
    fs.writeFileSync(template, `${example.replace('{ deep: false }', '{ think: false }')}\n// think: step by step\n`);
    expect(() => compileSkillApp(fs.readFileSync(template, 'utf-8'))).toThrow(/`think` was renamed to `deep`/);
    expect(legacyThinkApps(appsDir)).toEqual([template]);
    migrateAppThink(appsDir, template);
    expect(fs.readFileSync(template, 'utf-8')).toContain('// think: step by step');
    expect(() => compileSkillApp(fs.readFileSync(template, 'utf-8'))).not.toThrow();
    expect(legacyThinkApps(appsDir)).toEqual([]);
  });
});
