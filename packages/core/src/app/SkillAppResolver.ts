import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { resolveSkillValuesInvocation } from '../skill/SkillInvocation';
import type { ResolvedSkillInvocation } from '../skill/SkillInvocation';
import { parseSkill } from '../skill/SkillValidator';
import type { MarifoldSkill } from '../skill/SkillSchema';
import type { AppStore } from './AppStore';
import type {
  SkillAppDefinition,
  SkillAppModelDefinition,
  SkillAppOperationDefinition,
  SkillAppProfileDefinition,
  SkillAppSkillDefinition,
  SkillAppStateValue,
} from './SkillAppSchema';

export interface ResolvedSkillAppOperation extends ResolvedSkillInvocation {
  appName: string;
  operationName: string;
  output: string;
  model?: SkillAppModelDefinition;
  profile?: SkillAppProfileDefinition;
  result: SkillAppSkillDefinition['result'];
  /** Exact selected Skill folder mounted read-only for profile Agent runs. */
  skillDirectory?: string;
}

export function resolveSkillAppOperation(
  store: AppStore,
  definition: SkillAppDefinition,
  operationName: string,
  state: Record<string, SkillAppStateValue>,
): ResolvedSkillAppOperation {
  const operation = requireOperation(definition, operationName);
  let model: SkillAppModelDefinition | undefined;
  let profile: SkillAppProfileDefinition | undefined;
  let skill: MarifoldSkill;
  let result: SkillAppSkillDefinition['result'];
  let source: string | undefined;
  let selectedSkillName: string;
  if (operation.profile) {
    profile = (definition.profiles ?? []).find(candidate => candidate.name === operation.profile);
    if (!profile || !operation.result) {
      throw MarifoldError.appInvalid(`SkillApp operation '${operationName}' has an invalid profile or result reference.`);
    }
    selectedSkillName = resolveProfileSkillName(operation, state);
    skill = store.requireProfileSkill(profile.profile, selectedSkillName);
    source = skill.source;
    result = operation.result;
  } else {
    if (!operation.skill) {
      throw MarifoldError.appInvalid(`SkillApp operation '${operationName}' has no app-local Skill reference.`);
    }
    selectedSkillName = operation.skill;
    model = definition.models.find(candidate => candidate.name === operation.model);
    const registeredSkill = definition.skills.find(candidate => candidate.name === selectedSkillName);
    if (!model || !registeredSkill) {
      throw MarifoldError.appInvalid(`SkillApp operation '${operationName}' has an invalid model or Skill reference.`);
    }
    source = store.requireLocalSkillSource(definition.app.name, registeredSkill.name);
    skill = parseSkill(fs.readFileSync(source, 'utf-8'), source);
    if (skill.name !== registeredSkill.name) {
      throw MarifoldError.appInvalid(
        `App-local Skill folder '${registeredSkill.name}' contains Skill '${skill.name}'. Names must match.`,
        source,
      );
    }
    result = registeredSkill.result;
  }

  const parameters: Record<string, string> = {};
  for (const [parameter, stateName] of Object.entries(operation.parameters)) {
    parameters[parameter] = state[stateName] ?? '';
  }
  const knownParameters = new Set(skill.variables.map(variable => variable.name));
  const unknown = Object.keys(parameters).filter(name => !knownParameters.has(name));
  if (unknown.length > 0) {
    throw MarifoldError.appInvalid(
      `SkillApp operation '${operationName}' supplies unknown Skill parameter(s): ${unknown.join(', ')}.`,
      source,
    );
  }
  const userTurn = `App · ${definition.app.title} · ${operationName}`;
  const rawPrompt = operation.input === undefined ? undefined : (state[operation.input] ?? '');
  const prompt = rawPrompt !== undefined && operation.stripSkillName
    ? stripLeadingSkillName(rawPrompt, operation.skillOptions ?? [selectedSkillName])
    : rawPrompt;
  if (operation.input !== undefined && prompt !== undefined && prompt.trim().length === 0) {
    throw MarifoldError.appInvalid(
      `SkillApp operation '${operationName}' requires input beyond the selected Skill name.`,
    );
  }
  const resolved = resolveSkillValuesInvocation(skill, parameters, userTurn, prompt);
  if (resolved.missing.length > 0) {
    throw MarifoldError.appInvalid(
      `SkillApp operation '${operationName}' is missing required Skill values: ${resolved.missing.join(', ')}.`,
      source,
    );
  }
  if (!profile && resolved.mode && resolved.mode !== 'chat') {
    throw MarifoldError.appInvalid(
      `SkillApp v1 only supports chat-mode Skills; '${skill.name}' uses '${resolved.mode}'.`,
      source,
    );
  }
  return {
    ...resolved,
    // v1 app-local runs remain tool-free. Profile-backed runs preserve the
    // ordinary invocation's exact bundled-file instruction for narrow
    // read-only access through the profile Skill runtime.
    instructions: profile ? resolved.instructions : [resolved.instructions[0]],
    appName: definition.app.name,
    operationName,
    output: operation.output,
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
    ...(profile && source ? { skillDirectory: path.dirname(source) } : {}),
    result,
  };
}

function resolveProfileSkillName(
  operation: SkillAppOperationDefinition,
  state: Record<string, SkillAppStateValue>,
): string {
  if (operation.skill) return operation.skill;
  const selected = operation.skillState ? state[operation.skillState] ?? '' : '';
  if (!selected || !operation.skillOptions?.includes(selected)) {
    throw MarifoldError.appInvalid(
      `SkillApp operation '${operation.name}' selected a profile Skill outside its static allowlist.`,
    );
  }
  return selected;
}

function stripLeadingSkillName(input: string, skills: string[]): string {
  const escaped = [...skills]
    .sort((left, right) => right.length - left.length)
    .map(skill => skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return input;
  return input.replace(
    new RegExp(`^\\s*\\$?(?:${escaped.join('|')})(?=\\s|:|$)\\s*:?\\s*`, 'i'),
    '',
  );
}

function requireOperation(
  definition: SkillAppDefinition,
  operationName: string,
): SkillAppOperationDefinition {
  const operation = definition.operations.find(candidate => candidate.name === operationName);
  if (!operation) {
    throw MarifoldError.appInvalid(
      `SkillApp '${definition.app.name}' has no operation named '${operationName}'.`,
    );
  }
  return operation;
}
