import { MarifoldError } from '../errors/MarifoldError';
import { MarifoldSkill } from '../skill/SkillSchema';
import {
  ResolvedSkillInvocation,
  resolveSkillValuesInvocation,
} from '../skill/SkillInvocation';
import {
  AppAction,
  AppDefinition,
  AppExecution,
  AppVariable,
  AppVariableValue,
} from './AppSchema';

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

export interface ResolvedAppAction extends ResolvedSkillInvocation {
  appName: string;
  actionName: string;
  actorName: string;
  profile: string;
  output: string;
  execution: AppExecution;
}

/** Validate renderer state and resolve one server-owned Skill action. Clients
 * send values only; they cannot replace the Skill, prompt, or execution policy. */
export function resolveAppAction(
  definition: AppDefinition,
  actionName: string,
  supplied: Record<string, unknown>,
  skill: MarifoldSkill,
): ResolvedAppAction {
  const action = definition.actions.find(candidate => candidate.name === actionName);
  if (!action) {
    throw MarifoldError.appInvalid(
      `App '${definition.app.name}' has no action named '${actionName}'.`,
    );
  }
  const actor = definition.actors.find(candidate => candidate.name === action.actor);
  if (!actor) {
    throw MarifoldError.appInvalid(`App action '${actionName}' references missing actor '${action.actor}'.`);
  }
  if (action.skill !== skill.name) {
    throw MarifoldError.appInvalid(
      `App action '${actionName}' expected skill '${action.skill}', not '${skill.name}'.`,
    );
  }

  const values = validateValues(definition, supplied);
  const skillVariables = new Set(skill.variables.map(variable => variable.name));
  const argumentsByName: Record<string, string> = {};
  for (const [name, value] of Object.entries(action.arguments)) {
    if (!skillVariables.has(name)) {
      throw MarifoldError.appInvalid(
        `App action '${actionName}' supplies unknown skill variable '${name}'.`,
      );
    }
    argumentsByName[name] = renderArgument(value, values);
  }

  const userTurn = renderUserTurn(definition, action, values);
  const resolved = resolveSkillValuesInvocation(skill, argumentsByName, userTurn);
  if (resolved.missing.length > 0) {
    throw MarifoldError.appInvalid(
      `App action '${actionName}' is missing required skill values: ${resolved.missing.join(', ')}.`,
    );
  }
  return {
    ...resolved,
    appName: definition.app.name,
    actionName,
    actorName: actor.name,
    profile: actor.profile,
    output: action.output,
    execution: definition.execution,
  };
}

function validateValues(
  definition: AppDefinition,
  supplied: Record<string, unknown>,
): Record<string, AppVariableValue> {
  const allowed = new Map(
    definition.variables
      .filter(variable => variable.role !== 'output')
      .map(variable => [variable.name, variable]),
  );
  for (const name of Object.keys(supplied)) {
    if (!allowed.has(name)) {
      throw MarifoldError.appInvalid(`App received unknown or read-only variable '${name}'.`);
    }
  }

  const values: Record<string, AppVariableValue> = {};
  for (const variable of allowed.values()) {
    const candidate = supplied[variable.name] ?? variable.default;
    if (candidate === undefined || candidate === '') {
      if (variable.required) {
        throw MarifoldError.appInvalid(`App variable '${variable.name}' is required.`);
      }
      values[variable.name] = emptyValue(variable);
      continue;
    }
    if (!matchesType(variable, candidate)) {
      throw MarifoldError.appInvalid(
        `App variable '${variable.name}' does not match type '${variable.type}'.`,
      );
    }
    values[variable.name] = candidate;
  }
  return values;
}

function matchesType(variable: AppVariable, value: unknown): value is AppVariableValue {
  switch (variable.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && (variable.options ?? []).includes(value);
  }
}

function emptyValue(variable: AppVariable): AppVariableValue {
  if (variable.type === 'number') return 0;
  if (variable.type === 'boolean') return false;
  return '';
}

function renderArgument(
  argument: AppVariableValue,
  values: Record<string, AppVariableValue>,
): string {
  if (typeof argument !== 'string') return String(argument);
  return argument.replace(PLACEHOLDER, (_match, name: string) => String(values[name] ?? ''));
}

function renderUserTurn(
  definition: AppDefinition,
  action: AppAction,
  values: Record<string, AppVariableValue>,
): string {
  const inputs = definition.variables
    .filter(variable => variable.role === 'input')
    .map(variable => `${variable.label ?? variable.name}: ${String(values[variable.name] ?? '')}`)
    .join('\n');
  return `App · ${definition.app.title} · ${action.name}${inputs ? `\n${inputs}` : ''}`;
}
