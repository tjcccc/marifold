import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { parseSkill } from '../skill/SkillValidator';
import type { MarifoldSkill } from '../skill/SkillSchema';
import { resolveHostReadGrant } from './HostReadGrants';
import { compileSkillApp } from './SkillAppCompiler';
import type { SkillAppCatalog, SkillAppDefinition, SkillAppOperationDefinition } from './SkillAppSchema';

const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_APP_DEFINITION_FILE = 'skillapp.ts';

export interface AppStoreOptions {
  /** Resolve exactly as a normal invocation from this profile: profile Skills
   * shadow global Skills. Runtime wiring also validates that the profile exists. */
  resolveProfileSkill?: (profile: string, skillName: string) => MarifoldSkill | undefined;
}

/** Global App bundles under `<appsDir>/<name>/skillapp.ts`. Invalid bundles
 * are skipped by list(); listCatalog() and get() report their exact failure. */
export class AppStore {
  constructor(
    private readonly directory: string,
    private readonly options: AppStoreOptions = {},
  ) {}

  list(): SkillAppDefinition[] {
    return this.listCatalog().apps;
  }

  /** Valid definitions plus every bundle that failed to load, so renderers can
   * show why an App is unavailable instead of silently hiding it. */
  listCatalog(): SkillAppCatalog {
    if (!fs.existsSync(this.directory)) { return { apps: [], invalid: [] }; }
    const catalog: SkillAppCatalog = { apps: [], invalid: [] };
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_APP_NAME.test(entry.name)) { continue; }
      try {
        const app = this.get(entry.name);
        if (app) { catalog.apps.push(app); }
      } catch (error) {
        // A catalog stays usable when one local definition is malformed.
        catalog.invalid.push({
          name: entry.name,
          code: error instanceof MarifoldError ? error.code : 'APP_INVALID',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    catalog.apps.sort((a, b) => a.app.title.localeCompare(b.app.title));
    catalog.invalid.sort((a, b) => a.name.localeCompare(b.name));
    return catalog;
  }

  get(name: string): SkillAppDefinition | undefined {
    assertSafeAppName(name);
    const bundle = path.join(this.directory, name);
    const skillAppSource = path.join(bundle, SKILL_APP_DEFINITION_FILE);
    if (!fs.existsSync(skillAppSource)) { return undefined; }
    const realSource = requireConfinedFile(bundle, skillAppSource, 'SkillApp definition');
    const definition = compileSkillApp(fs.readFileSync(realSource, 'utf-8'), realSource);
    if (definition.app.name !== name) {
      throw MarifoldError.appInvalid(
        `App app.name '${definition.app.name}' must match bundle directory '${name}'.`,
        realSource,
      );
    }
    definition.permissions = resolvePermissions(bundle, definition.permissions ?? [], realSource);
    this.validateLocalSkills(name, definition);
    this.validateProfileSkills(definition);
    return definition;
  }

  require(name: string): SkillAppDefinition {
    const app = this.get(name);
    if (!app) { throw MarifoldError.appNotFound(name); }
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
    if (!fs.existsSync(source)) { throw MarifoldError.skillNotFound(skillName); }
    return requireConfinedFile(bundle, source, `App-local skill '${skillName}'`);
  }

  requireProfileSkill(profile: string, skillName: string): MarifoldSkill {
    const skill = this.options.resolveProfileSkill?.(profile, skillName);
    if (!skill) { throw MarifoldError.skillNotFound(skillName); }
    return skill;
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
      for (const operation of definition.operations.filter(
        candidate => candidate.profile === undefined && candidate.skill === registered.name,
      )) {
        operation.requiredInputs = this.validateOperationBindings(skill, operation, source);
      }
    }
  }

  private validateProfileSkills(definition: SkillAppDefinition): void {
    for (const operation of definition.operations.filter(candidate => candidate.profile !== undefined)) {
      const profile = (definition.profiles ?? []).find(candidate => candidate.name === operation.profile);
      if (!profile) {
        throw MarifoldError.appInvalid(
          `SkillApp operation '${operation.name}' references missing profile '${operation.profile}'.`,
        );
      }
      if (!this.options.resolveProfileSkill) {
        throw MarifoldError.appInvalid(
          `SkillApp '${definition.app.name}' requires profile-backed Skill resolution.`,
        );
      }
      const skillNames = operation.skill ? [operation.skill] : (operation.skillOptions ?? []);
      if (skillNames.length === 0) {
        throw MarifoldError.appInvalid(
          `SkillApp operation '${operation.name}' has no profile Skill candidates.`,
        );
      }
      const requiredInputs = new Set<string>([
        ...(operation.skillState ? [operation.skillState] : []),
        ...(operation.input ? [operation.input] : []),
      ]);
      for (const skillName of skillNames) {
        const skill = this.requireProfileSkill(profile.profile, skillName);
        if (operation.interactive && skill.mode === 'chat') {
          throw MarifoldError.appInvalid(
            `Interactive SkillApp operation '${operation.name}' cannot invoke chat-mode Skill '${skillName}'.`,
            skill.source,
          );
        }
        if (skillName === 'skillapp-builder' && !operation.interactive) {
          throw MarifoldError.appInvalid(
            `SkillApp operation '${operation.name}' must invoke the built-in skillapp-builder interactively.`,
            skill.source,
          );
        }
        for (const input of this.validateOperationBindings(skill, operation, skill.source)) {
          requiredInputs.add(input);
        }
      }
      operation.requiredInputs = [...requiredInputs];
    }
  }

  private validateOperationBindings(
    skill: MarifoldSkill,
    operation: SkillAppOperationDefinition,
    source?: string,
  ): string[] {
    const variables = new Set(skill.variables.map(variable => variable.name));
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
    return [...new Set([
      ...(operation.input ? [operation.input] : []),
      ...skill.variables
        .filter(variable => variable.required && variable.default === undefined)
        .map(variable => operation.parameters[variable.name]),
    ])];
  }
}

function resolvePermissions(
  bundle: string,
  permissions: NonNullable<SkillAppDefinition['permissions']>,
  source: string,
): NonNullable<SkillAppDefinition['permissions']> {
  return permissions.map(permission => ({
    ...permission,
    path: resolveHostReadGrant({
      declared: permission.path,
      kind: permission.kind,
      relativeTo: bundle,
      allowedPrivateRoot: bundle,
      label: 'Declared',
      noun: 'permission',
      source,
    }),
  }));
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
