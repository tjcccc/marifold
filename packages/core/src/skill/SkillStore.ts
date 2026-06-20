import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { MarifoldSkill } from './SkillSchema';
import { parseSkill } from './SkillValidator';

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface SkillStoreOptions {
  /** Shared skills directory ([paths].skills_dir, default ~/.marifold/skills). */
  globalDir: string;
  /** Active profile's skills/ directory; its skills shadow global ones. */
  profileDir?: string;
}

export type SkillScope = 'global' | 'profile';

/**
 * Loads `marifold.skill.v0` skills from the shared skills dir and the active
 * profile's skills/ dir. Each skill is a folder `<name>/SKILL.md` (the Claude
 * Code layout), so a skill can carry bundled files. A profile skill shadows a
 * global one of the same name. Skills are the TUI's `$name` primitive and a
 * future SkillApp's source.
 */
export class SkillStore {
  constructor(private readonly options: SkillStoreOptions) {}

  /** Loadable skills, sorted by name. With no scope, profile skills shadow
   * global ones (the merged, runnable set); pass a scope to list just that
   * layer. Folders that fail to parse are skipped — use get() for a precise
   * error on a single named skill. */
  list(scope?: SkillScope): MarifoldSkill[] {
    const byName = new Map<string, MarifoldSkill>();
    if (scope !== 'profile') {
      for (const skill of this.loadDir(this.options.globalDir, 'global')) byName.set(skill.name, skill);
    }
    if (scope !== 'global' && this.options.profileDir) {
      for (const skill of this.loadDir(this.options.profileDir, 'profile')) byName.set(skill.name, skill);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): MarifoldSkill | undefined {
    assertSafeName(name);
    // Profile takes precedence over global.
    for (const [dir, scope] of this.scopedDirs().reverse()) {
      const skillMd = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        return { ...parseSkill(fs.readFileSync(skillMd, 'utf-8'), skillMd), scope };
      }
    }
    return undefined;
  }

  require(name: string): MarifoldSkill {
    const skill = this.get(name);
    if (!skill) throw MarifoldError.skillNotFound(name);
    return skill;
  }

  /** Validate then write a skill into the target scope as `<name>/SKILL.md`. */
  installFromText(text: string, scope: SkillScope = 'global'): MarifoldSkill {
    const skill = parseSkill(text);
    const skillDir = path.join(this.dirForScope(scope), skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillMd, text.endsWith('\n') ? text : `${text}\n`);
    return { ...skill, source: skillMd, scope };
  }

  /** Install from a `.md` file or a Claude Code-style skill folder containing
   * `SKILL.md`. Either way the skill lands at `<scope>/<name>/SKILL.md`; a
   * folder source is copied whole (bundled files travel, though marifold
   * currently only uses SKILL.md). */
  installFromFile(filePath: string, scope: SkillScope = 'global'): MarifoldSkill {
    const { skillMd, folder } = resolveSkillSource(filePath);
    const text = fs.readFileSync(skillMd, 'utf-8');
    if (!folder) return this.installFromText(text, scope);
    const skill = parseSkill(text, skillMd); // validate before writing
    const destDir = path.join(this.dirForScope(scope), skill.name);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.cpSync(folder, destDir, { recursive: true });
    return { ...skill, source: path.join(destDir, 'SKILL.md'), scope };
  }

  /** Remove a skill (its whole `<name>/` folder). With no scope, deletes it
   * from every layer; pass a scope to delete only that layer (e.g. the profile
   * copy, revealing a global one). */
  remove(name: string, scope?: SkillScope): boolean {
    assertSafeName(name);
    let removed = false;
    for (const [dir, dirScope] of this.scopedDirs()) {
      if (scope !== undefined && dirScope !== scope) continue;
      const skillDir = path.join(dir, name);
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        removed = true;
      }
    }
    return removed;
  }

  private scopedDirs(): Array<[string, SkillScope]> {
    const dirs: Array<[string, SkillScope]> = [[this.options.globalDir, 'global']];
    if (this.options.profileDir) dirs.push([this.options.profileDir, 'profile']);
    return dirs;
  }

  private dirForScope(scope: SkillScope): string {
    if (scope === 'profile') {
      if (!this.options.profileDir) {
        throw MarifoldError.skillInvalid('No profile skills directory is configured for this store.');
      }
      return this.options.profileDir;
    }
    return this.options.globalDir;
  }

  private loadDir(dir: string, scope: SkillScope): MarifoldSkill[] {
    if (!fs.existsSync(dir)) return [];
    const skills: MarifoldSkill[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        skills.push({ ...parseSkill(fs.readFileSync(skillMd, 'utf-8'), skillMd), scope });
      } catch {
        // Skip unparseable skill folders; get() surfaces the precise error.
      }
    }
    return skills;
  }
}

function assertSafeName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw MarifoldError.skillInvalid(`Invalid skill name '${name}'.`);
  }
}

/** Resolve an install target to its `SKILL.md` and, for a folder source, the
 * folder to copy: a `.md` file directly, or a `SKILL.md` inside a skill folder. */
function resolveSkillSource(target: string): { skillMd: string; folder?: string } {
  if (!fs.existsSync(target)) {
    throw MarifoldError.skillInvalid(`Skill not found: ${target}`);
  }
  if (fs.statSync(target).isDirectory()) {
    const skillMd = path.join(target, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      throw MarifoldError.skillInvalid(`Skill folder has no SKILL.md: ${target}`);
    }
    return { skillMd, folder: target };
  }
  return { skillMd: target };
}
