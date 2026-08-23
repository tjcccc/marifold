import * as fs from 'fs';
import { MarifoldError } from '../errors/MarifoldError';
import { resolveSkillValuesInvocation } from '../skill/SkillInvocation';
import type { ResolvedSkillInvocation } from '../skill/SkillInvocation';
import { parseSkill } from '../skill/SkillValidator';
import type { AppStore } from './AppStore';
import type {
  SkillAppDefinition,
  SkillAppModelDefinition,
  SkillAppOperationDefinition,
  SkillAppSkillDefinition,
  SkillAppStateValue,
} from './SkillAppSchema';

export interface ResolvedSkillAppOperation extends ResolvedSkillInvocation {
  appName: string;
  operationName: string;
  output: string;
  model: SkillAppModelDefinition;
  result: SkillAppSkillDefinition['result'];
}

export function resolveSkillAppOperation(
  store: AppStore,
  definition: SkillAppDefinition,
  operationName: string,
  state: Record<string, SkillAppStateValue>,
): ResolvedSkillAppOperation {
  const operation = requireOperation(definition, operationName);
  const model = definition.models.find(candidate => candidate.name === operation.model);
  const registeredSkill = definition.skills.find(candidate => candidate.name === operation.skill);
  if (!model || !registeredSkill) {
    throw MarifoldError.appInvalid(`SkillApp operation '${operationName}' has an invalid model or Skill reference.`);
  }

  const source = store.requireLocalSkillSource(definition.app.name, registeredSkill.name);
  const skill = parseSkill(fs.readFileSync(source, 'utf-8'), source);
  if (skill.name !== registeredSkill.name) {
    throw MarifoldError.appInvalid(
      `App-local Skill folder '${registeredSkill.name}' contains Skill '${skill.name}'. Names must match.`,
      source,
    );
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
  const resolved = resolveSkillValuesInvocation(skill, parameters, userTurn);
  if (resolved.missing.length > 0) {
    throw MarifoldError.appInvalid(
      `SkillApp operation '${operationName}' is missing required Skill values: ${resolved.missing.join(', ')}.`,
      source,
    );
  }
  if (resolved.mode && resolved.mode !== 'chat') {
    throw MarifoldError.appInvalid(
      `SkillApp v1 only supports chat-mode Skills; '${skill.name}' uses '${resolved.mode}'.`,
      source,
    );
  }
  return {
    ...resolved,
    // v1 has no file-reading tools; do not expose host paths or instructions
    // for bundled files even when the Skill folder contains additional assets.
    instructions: [resolved.instructions[0]],
    appName: definition.app.name,
    operationName,
    output: operation.output,
    model,
    result: registeredSkill.result,
  };
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
