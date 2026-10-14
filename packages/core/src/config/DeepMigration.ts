import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'smol-toml';

/**
 * `think` became `deep` on 2026-10-14 with no alias, so `marifold doctor`
 * finds the old name and `--fix` rewrites it after a backup: `[default].think`
 * in config.toml (which the loader would otherwise ignore, leaving Deep off)
 * and `think:` options in installed SkillApp templates (which fail to compile).
 */

/** The `[default].think` value still in config.toml, if any. */
export function legacyDefaultThink(configPath: string): boolean | undefined {
  if (!fs.existsSync(configPath)) { return undefined; }
  const raw = parse(fs.readFileSync(configPath, 'utf-8')) as { default?: { think?: unknown } };
  return typeof raw.default?.think === 'boolean' ? raw.default.think : undefined;
}

/** Rename `think` to `deep` in the `[default]` table; returns the backup path. */
export function migrateDefaultThink(configPath: string): string | undefined {
  if (legacyDefaultThink(configPath) === undefined) { return undefined; }
  const text = fs.readFileSync(configPath, 'utf-8');
  let table = '';
  const next = text.split(/\r?\n/).map(line => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) { table = header[1]!.trim(); }
    return table === 'default' ? line.replace(/^(\s*)think(\s*=)/, '$1deep$2') : line;
  }).join('\n');
  const backupPath = backup(configPath, path.join(path.dirname(configPath), '.legacy-config'));
  fs.writeFileSync(configPath, next);
  return backupPath;
}

/** `think: true|false` as an option in a template; prose is left alone. */
const THINK_OPTION = /\bthink(\s*:\s*(?:true|false)\b)/g;

/** Installed SkillApp templates that still use `think:`. */
export function legacyThinkApps(appsDir: string): string[] {
  if (!fs.existsSync(appsDir)) { return []; }
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(appsDir, entry.name, 'skillapp.ts'))
    .filter(file => fs.existsSync(file) && new RegExp(THINK_OPTION.source).test(fs.readFileSync(file, 'utf-8')));
}

/** Rewrite `think:` as `deep:` in one template; returns the backup path. */
export function migrateAppThink(appsDir: string, templatePath: string): string {
  const text = fs.readFileSync(templatePath, 'utf-8');
  const app = path.basename(path.dirname(templatePath));
  const backupPath = backup(templatePath, path.join(appsDir, '.legacy-skillapp', app));
  fs.writeFileSync(templatePath, text.replace(THINK_OPTION, 'deep$1'));
  return backupPath;
}

function backup(file: string, folder: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(folder, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  fs.copyFileSync(file, target);
  return target;
}
