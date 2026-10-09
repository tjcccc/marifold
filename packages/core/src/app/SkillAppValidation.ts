import type * as ts from 'typescript-compiler';
import { MarifoldError } from '../errors/MarifoldError';
import type { SkillAppLayoutItem, SkillAppPermissionDefinition } from './SkillAppSchema';
import { type CompilationState, type Evaluated, flatten, invalidAt, rejectUnknown, requireNonEmptyString, requireString, selectOptionValue, type TaggedValue } from './SkillAppCompilerSupport';

// Whole-template validation after evaluation: unique declarations, resolvable references, permissions, model ids, and app metadata.

export const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SAFE_PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function validateReferences(state: CompilationState, layout: SkillAppLayoutItem[], sourcePath: string): void {
  const stateNames = new Set(state.states.map(item => item.name));
  const attachmentStateNames = new Set(state.attachmentStates.map(item => item.name));
  const modelNames = new Set(state.models.map(item => item.name));
  const profileNames = new Set(state.profiles.map(item => item.name));
  const skillNames = new Set(state.skills.map(item => item.name));
  const operationNames = new Set(state.operations.map(item => item.name));
  assertUnique(state.models.map(item => item.name), 'model declarations', sourcePath);
  assertUnique(state.profiles.map(item => item.name), 'profile declarations', sourcePath);
  assertUnique(state.skills.map(item => item.name), 'registered Skills', sourcePath);
  assertUnique(state.operations.map(item => item.name), 'operations', sourcePath);
  assertUnique(state.attachmentStates.map(item => item.name), 'attachment state declarations', sourcePath);
  if (state.states.length === 0) { throw MarifoldError.appInvalid('SkillApp must declare at least one State.', sourcePath); }
  if (state.operations.length === 0) { throw MarifoldError.appInvalid('SkillApp must declare at least one useSkill or useProfileSkill operation.', sourcePath); }
  for (const operation of state.operations) {
    if (operation.interactive && (!operation.profile || !operation.skill || operation.skillState)) {
      throw MarifoldError.appInvalid(
        `Interactive operation '${operation.name}' must reference one fixed profile Agent Skill.`,
        sourcePath,
      );
    }
    if (operation.profile) {
      if (!profileNames.has(operation.profile)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing profile '${operation.profile}'.`, sourcePath); }
      if (operation.model) { throw MarifoldError.appInvalid(`Operation '${operation.name}' cannot reference both a profile and model.`, sourcePath); }
      const fixedSkill = operation.skill !== undefined;
      const selectedSkill = operation.skillState !== undefined;
      if (fixedSkill === selectedSkill) {
        throw MarifoldError.appInvalid(`Operation '${operation.name}' must reference exactly one fixed or state-selected profile Skill.`, sourcePath);
      }
      if (selectedSkill) {
        if (!stateNames.has(operation.skillState!)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing Skill state '${operation.skillState}'.`, sourcePath); }
        if (!operation.skillOptions?.length) { throw MarifoldError.appInvalid(`Operation '${operation.name}' requires a non-empty Skill allowlist.`, sourcePath); }
        const initial = state.states.find(candidate => candidate.name === operation.skillState)?.initial;
        if (initial !== undefined && !operation.skillOptions.includes(initial)) {
          throw MarifoldError.appInvalid(`Operation '${operation.name}' initial Skill '${initial}' is not allowlisted.`, sourcePath);
        }
      }
    } else {
      if (!operation.model || !modelNames.has(operation.model)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing model '${operation.model ?? ''}'.`, sourcePath); }
      if (!operation.skill || !skillNames.has(operation.skill)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing skill '${operation.skill ?? ''}'.`, sourcePath); }
    }
    if (!stateNames.has(operation.output)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing output state '${operation.output}'.`, sourcePath); }
    if (operation.input && !stateNames.has(operation.input)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing input state '${operation.input}'.`, sourcePath); }
    if (operation.attachments && !attachmentStateNames.has(operation.attachments)) {
      throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing attachment state '${operation.attachments}'.`, sourcePath);
    }
    for (const name of Object.values(operation.parameters)) {
      if (!stateNames.has(name)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing state '${name}'.`, sourcePath); }
    }
  }
  const layoutItems = flatten(layout);
  if (layoutItems.length > 100) { throw MarifoldError.appInvalid('SkillApp layout cannot exceed 100 components.', sourcePath); }
  for (const operation of state.operations.filter(candidate => candidate.skillState)) {
    const selectors = layoutItems.filter(item => item.component === 'select' && item.bind === operation.skillState);
    if (selectors.length === 0) {
      throw MarifoldError.appInvalid(`Operation '${operation.name}' Skill state '${operation.skillState}' must bind to Select.`, sourcePath);
    }
    const selectable = new Set(selectors.flatMap(item => (item.options ?? []).map(selectOptionValue)));
    const allowlisted = new Set(operation.skillOptions ?? []);
    if (selectable.size !== allowlisted.size || [...selectable].some(skill => !allowlisted.has(skill))) {
      throw MarifoldError.appInvalid(`Operation '${operation.name}' Select options must exactly match its Skill allowlist.`, sourcePath);
    }
  }
  for (const item of layoutItems) {
    if (item.component === 'app') { throw MarifoldError.appInvalid('App(...) can only be the root UI component.', sourcePath); }
    if (item.bind && item.component === 'attachments' && !attachmentStateNames.has(item.bind)) {
      throw MarifoldError.appInvalid(`Layout references missing attachment state '${item.bind}'.`, sourcePath);
    }
    if (item.bind && item.component !== 'attachments' && !stateNames.has(item.bind)) {
      throw MarifoldError.appInvalid(`Layout references missing state '${item.bind}'.`, sourcePath);
    }
    if (item.trigger && !operationNames.has(item.trigger)) { throw MarifoldError.appInvalid(`Button references missing operation '${item.trigger}'.`, sourcePath); }
    if (item.component === 'select' && item.bind) {
      const initial = state.states.find(candidate => candidate.name === item.bind)?.initial;
      if (initial !== undefined && !(item.options ?? []).map(selectOptionValue).includes(initial)) {
        throw MarifoldError.appInvalid(`Select state '${item.bind}' initial value must be one of its options.`, sourcePath);
      }
    }
  }
  for (const triggerDefinition of state.triggers) {
    if (!operationNames.has(triggerDefinition.operation)) { throw MarifoldError.appInvalid(`Trigger references missing operation '${triggerDefinition.operation}'.`, sourcePath); }
    if (state.operations.find(operation => operation.name === triggerDefinition.operation)?.interactive) {
      throw MarifoldError.appInvalid(`Interactive operation '${triggerDefinition.operation}' cannot use an automatic trigger.`, sourcePath);
    }
    for (const name of triggerDefinition.onChange) {
      if (!stateNames.has(name)) { throw MarifoldError.appInvalid(`Trigger references missing state '${name}'.`, sourcePath); }
    }
  }
  const outputStates = new Set(state.operations.map(operation => operation.output));
  for (const operation of state.operations) {
    for (const input of [operation.input, operation.skillState, ...Object.values(operation.parameters)]) {
      if (!input) { continue; }
      if (outputStates.has(input)) { throw MarifoldError.appInvalid(`Operation '${operation.name}' cannot use output state '${input}' as an input.`, sourcePath); }
    }
  }
  for (const item of layoutItems) {
    if (!item.bind || !outputStates.has(item.bind)) { continue; }
    if (item.component === 'select') {
      throw MarifoldError.appInvalid(`Output state '${item.bind}' cannot bind to Select.`, sourcePath);
    }
    if (item.component === 'textarea' && item.editable !== false) {
      throw MarifoldError.appInvalid(`Output state '${item.bind}' must use Textarea(..., { editable: false }).`, sourcePath);
    }
  }
  for (const triggerDefinition of state.triggers) {
    const outputDependency = triggerDefinition.onChange.find(name => outputStates.has(name));
    if (outputDependency) {
      throw MarifoldError.appInvalid(`Trigger cannot watch output state '${outputDependency}'.`, sourcePath);
    }
  }
}

export function normalizePermissions(
  values: TaggedValue[],
  state: CompilationState,
  sourcePath: string,
): SkillAppPermissionDefinition[] {
  const permissions = values.map(value => ({
    kind: requireString(value.resource, 'permission resource', state.sourceFile, state, sourcePath) as 'file' | 'folder',
    path: requireNonEmptyString(value.path, 'permission path', state.sourceFile, state, sourcePath),
    access: requireString(value.access, 'permission access', state.sourceFile, state, sourcePath) as 'read',
  }));
  const duplicate = permissions.find((permission, index) => permissions.findIndex(candidate => (
    candidate.kind === permission.kind && candidate.path === permission.path
  )) !== index);
  if (duplicate) { throw MarifoldError.appInvalid(`Duplicate ${duplicate.kind} permission '${duplicate.path}'.`, sourcePath); }
  return permissions;
}

export function parseModelId(
  id: string,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): { provider: string; model: string } {
  const separator = id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) {
    throw invalidAt(state.sourceFile, node.pos, `Model '${id}' must use provider/model format.`, sourcePath);
  }
  const provider = id.slice(0, separator);
  if (!SAFE_PROVIDER_NAME.test(provider)) {
    throw invalidAt(state.sourceFile, node.pos, `Invalid model provider '${provider}'.`, sourcePath);
  }
  const model = id.slice(separator + 1);
  if (model.trim() !== model || model.length === 0) {
    throw invalidAt(state.sourceFile, node.pos, `Invalid model id '${model}'.`, sourcePath);
  }
  return { provider, model };
}

export function assertUnique(values: string[], label: string, sourcePath: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) { throw MarifoldError.appInvalid(`Duplicate ${label}: '${value}'.`, sourcePath); }
    seen.add(value);
  }
}

export function normalizeAppInfo(raw: Record<string, Evaluated>, state: CompilationState, sourcePath: string) {
  rejectUnknown(raw, ['name', 'title', 'version', 'description'], 'app metadata', state.sourceFile, state, sourcePath);
  const name = requireNonEmptyString(raw.name, 'app.name', state.sourceFile, state, sourcePath);
  if (!SAFE_APP_NAME.test(name)) { throw MarifoldError.appInvalid(`Invalid App name '${name}'. Use kebab-case.`, sourcePath); }
  return {
    name,
    title: requireNonEmptyString(raw.title, 'app.title', state.sourceFile, state, sourcePath),
    ...(raw.version !== undefined ? { version: requireNonEmptyString(raw.version, 'app.version', state.sourceFile, state, sourcePath) } : {}),
    ...(raw.description !== undefined ? { description: requireString(raw.description, 'app.description', state.sourceFile, state, sourcePath) } : {}),
  };
}
