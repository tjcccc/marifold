import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { parseSkill } from '../skill/SkillValidator';
import { compileSkillApp } from './SkillAppCompiler';
import type { SkillAppDefinition } from './SkillAppSchema';

const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_APP_DEFINITION_FILE = 'skillapp.ts';

/** Global App bundles under `<appsDir>/<name>/skillapp.ts`. Invalid bundles
 * are skipped by list(); get() reports their exact validation failure. */
export class AppStore {
  constructor(private readonly directory: string) {}

  list(): SkillAppDefinition[] {
    if (!fs.existsSync(this.directory)) return [];
    const apps: SkillAppDefinition[] = [];
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_APP_NAME.test(entry.name)) continue;
      try {
        const app = this.get(entry.name);
        if (app) apps.push(app);
      } catch {
        // A catalog stays usable when one local definition is malformed.
      }
    }
    return apps.sort((a, b) => a.app.title.localeCompare(b.app.title));
  }

  get(name: string): SkillAppDefinition | undefined {
    assertSafeAppName(name);
    const bundle = path.join(this.directory, name);
    const skillAppSource = path.join(bundle, SKILL_APP_DEFINITION_FILE);
    if (!fs.existsSync(skillAppSource)) return undefined;
    const realSource = requireConfinedFile(bundle, skillAppSource, 'SkillApp definition');
    const definition = compileSkillApp(fs.readFileSync(realSource, 'utf-8'), realSource);
    if (definition.app.name !== name) {
      throw MarifoldError.appInvalid(
        `App app.name '${definition.app.name}' must match bundle directory '${name}'.`,
        realSource,
      );
    }
    this.validateLocalSkills(name, definition);
    return definition;
  }

  require(name: string): SkillAppDefinition {
    const app = this.get(name);
    if (!app) throw MarifoldError.appNotFound(name);
    return app;
  }

  /** Resolve one v1 app-local Skill without profile/global fallback. */
  requireLocalSkillSource(appName: string, skillName: string): string {
    assertSafeAppName(appName);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(skillName)) {
      throw MarifoldError.appInvalid(`Invalid app-local skill name '${skillName}'.`);
    }
    const bundle = path.join(this.directory, appName);
    const source = path.join(bundle, 'skills', skillName, 'SKILL.md');
    if (!fs.existsSync(source)) throw MarifoldError.skillNotFound(skillName);
    return requireConfinedFile(bundle, source, `App-local skill '${skillName}'`);
  }

  private validateLocalSkills(appName: string, definition: SkillAppDefinition): void {
    for (const registered of definition.skills) {
      const source = this.requireLocalSkillSource(appName, registered.name);
      const skill = parseSkill(fs.readFileSync(source, 'utf-8'), source);
      if (skill.name !== registered.name) {
        throw MarifoldError.appInvalid(
          `App-local Skill folder '${registered.name}' contains Skill '${skill.name}'. Names must match.`,
          source,
        );
      }
      if (skill.mode && skill.mode !== 'chat') {
        throw MarifoldError.appInvalid(
          `SkillApp v1 only supports chat-mode Skills; '${skill.name}' uses '${skill.mode}'.`,
          source,
        );
      }
      const variables = new Set(skill.variables.map(variable => variable.name));
      for (const operation of definition.operations.filter(candidate => candidate.skill === registered.name)) {
        const parameters = new Set(Object.keys(operation.parameters));
        const unknown = [...parameters].filter(name => !variables.has(name));
        if (unknown.length > 0) {
          throw MarifoldError.appInvalid(
            `SkillApp operation '${operation.name}' supplies unknown Skill parameter(s): ${unknown.join(', ')}.`,
            source,
          );
        }
        const missing = skill.variables
          .filter(variable => variable.required && variable.default === undefined && !parameters.has(variable.name))
          .map(variable => variable.name);
        if (missing.length > 0) {
          throw MarifoldError.appInvalid(
            `SkillApp operation '${operation.name}' does not bind required Skill parameter(s): ${missing.join(', ')}.`,
            source,
          );
        }
        operation.requiredInputs = [...new Set(skill.variables
          .filter(variable => variable.required && variable.default === undefined)
          .map(variable => operation.parameters[variable.name]))];
      }
    }
  }
}

function requireConfinedFile(bundle: string, source: string, label: string): string {
  const bundleRoot = fs.realpathSync(bundle);
  const realSource = fs.realpathSync(source);
  const relative = path.relative(bundleRoot, realSource);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw MarifoldError.appInvalid(`${label} escapes bundle confinement.`, source);
  }
  return realSource;
}

function assertSafeAppName(name: string): void {
  if (!SAFE_APP_NAME.test(name)) {
    throw MarifoldError.appInvalid(`Invalid App name '${name}'.`);
  }
}
