import { parse } from 'smol-toml';
import { MarifoldError } from '../errors/MarifoldError';
import {
  extractTemplateVariables,
  MarifoldSkill,
  SkillMode,
  SkillVariable,
  SKILL_SCHEMA_ID,
} from './SkillSchema';

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_VARIABLE_NAME = /^[a-zA-Z0-9_]+$/;

type TomlObject = Record<string, unknown>;

/** Parse and validate a `marifold.skill.v0` TOML document. */
export function parseSkill(text: string, source?: string): MarifoldSkill {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw MarifoldError.skillInvalid(`Could not parse skill TOML: ${String(error)}`, source);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw MarifoldError.skillInvalid('A skill file must contain a TOML table.', source);
  }
  return validateSkill(raw as TomlObject, source);
}

export function validateSkill(raw: TomlObject, source?: string): MarifoldSkill {
  const schema = requireString(raw.schema, 'schema', source);
  if (schema !== SKILL_SCHEMA_ID) {
    throw MarifoldError.skillInvalid(`Expected schema = "${SKILL_SCHEMA_ID}" but found "${schema}".`, source);
  }

  const name = requireString(raw.name, 'name', source).trim();
  if (!SAFE_SKILL_NAME.test(name)) {
    throw MarifoldError.skillInvalid(
      `Invalid skill name '${name}'. Use lowercase letters, numbers, underscores, or hyphens (starting alphanumeric).`,
      source,
    );
  }

  const description = optionalString(raw.description, 'description', source)?.trim() ?? '';
  const prompt = requireString(raw.prompt, 'prompt', source).trim();
  if (prompt.length === 0) {
    throw MarifoldError.skillInvalid('A skill prompt cannot be empty.', source);
  }

  const mode = normalizeMode(raw.mode, source);
  const variables = normalizeVariables(raw.variables, source);

  // Every variable referenced in the prompt must be declared, so the TUI and a
  // graphical SkillApp resolve the same set before running the skill.
  const declared = new Set(variables.map(variable => variable.name));
  const referenced = extractTemplateVariables(prompt);
  const undeclared = referenced.filter(variable => !declared.has(variable));
  if (undeclared.length > 0) {
    throw MarifoldError.skillInvalid(
      `Prompt references undeclared variable(s): ${undeclared.join(', ')}. Declare them in [[variables]].`,
      source,
    );
  }

  return {
    name,
    description,
    prompt,
    mode,
    variables,
    ...(source ? { source } : {}),
  };
}

function normalizeMode(value: unknown, source?: string): SkillMode {
  if (value === undefined) return 'agent';
  const mode = requireString(value, 'mode', source);
  if (mode === 'agent' || mode === 'chat') return mode;
  throw MarifoldError.skillInvalid('Expected mode to be "agent" or "chat".', source);
}

function normalizeVariables(value: unknown, source?: string): SkillVariable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw MarifoldError.skillInvalid('Expected [[variables]] to be an array of tables.', source);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw MarifoldError.skillInvalid(`Expected variables[${index}] to be a table.`, source);
    }
    const variable = entry as TomlObject;
    const name = requireString(variable.name, `variables[${index}].name`, source).trim();
    if (!SAFE_VARIABLE_NAME.test(name)) {
      throw MarifoldError.skillInvalid(
        `Invalid variable name '${name}'. Use letters, numbers, or underscores.`,
        source,
      );
    }
    if (seen.has(name)) {
      throw MarifoldError.skillInvalid(`Duplicate variable '${name}'.`, source);
    }
    seen.add(name);
    const description = optionalString(variable.description, `variables[${index}].description`, source);
    const required = optionalBoolean(variable.required, `variables[${index}].required`, source) ?? false;
    const defaultValue = optionalString(variable.default, `variables[${index}].default`, source);
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      required,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  });
}

function requireString(value: unknown, label: string, source?: string): string {
  if (typeof value === 'string') return value;
  throw MarifoldError.skillInvalid(`Expected ${label} to be a string.`, source);
}

function optionalString(value: unknown, label: string, source?: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw MarifoldError.skillInvalid(`Expected ${label} to be a string.`, source);
}

function optionalBoolean(value: unknown, label: string, source?: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw MarifoldError.skillInvalid(`Expected ${label} to be a boolean.`, source);
}
