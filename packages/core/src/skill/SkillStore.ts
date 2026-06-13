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
 * Loads `marifold.skill.v0` files from the shared skills dir and the active
 * profile's skills/ dir. A profile skill shadows a global skill of the same
 * name. Skills are the TUI's `$name` primitive and a future SkillApp's source.
 */
export class SkillStore {
  constructor(private readonly options: SkillStoreOptions) {}

  /** All loadable skills, profile skills shadowing global, sorted by name.
   * Files that fail to parse are skipped so one broken skill can't hide the
   * rest; use get() for a precise error on a single named skill. */
  list(): MarifoldSkill[] {
    const byName = new Map<string, MarifoldSkill>();
    for (const skill of this.loadDir(this.options.globalDir, 'global')) {
      byName.set(skill.name, skill);
    }
    if (this.options.profileDir) {
      for (const skill of this.loadDir(this.options.profileDir, 'profile')) {
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): MarifoldSkill | undefined {
    assertSafeName(name);
    // Profile takes precedence over global.
    for (const [dir, scope] of this.scopedDirs().reverse()) {
      const filePath = path.join(dir, `${name}.toml`);
      if (fs.existsSync(filePath)) {
        const skill = parseSkill(fs.readFileSync(filePath, 'utf-8'), filePath);
        return { ...skill, scope };
      }
    }
    return undefined;
  }

  require(name: string): MarifoldSkill {
    const skill = this.get(name);
    if (!skill) throw MarifoldError.skillNotFound(name);
    return skill;
  }

  /** Validate then write a skill into the target scope, returning the stored skill. */
  installFromText(text: string, scope: SkillScope = 'global'): MarifoldSkill {
    const skill = parseSkill(text);
    const dir = this.dirForScope(scope);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${skill.name}.toml`);
    fs.writeFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`);
    return { ...skill, source: filePath, scope };
  }

  installFromFile(filePath: string, scope: SkillScope = 'global'): MarifoldSkill {
    if (!fs.existsSync(filePath)) {
      throw MarifoldError.skillInvalid(`Skill file not found: ${filePath}`);
    }
    return this.installFromText(fs.readFileSync(filePath, 'utf-8'), scope);
  }

  remove(name: string): boolean {
    assertSafeName(name);
    let removed = false;
    for (const [dir] of this.scopedDirs()) {
      const filePath = path.join(dir, `${name}.toml`);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath);
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
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
      const filePath = path.join(dir, entry.name);
      try {
        skills.push({ ...parseSkill(fs.readFileSync(filePath, 'utf-8'), filePath), scope });
      } catch {
        // Skip unparseable skill files; get() surfaces the precise error.
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
