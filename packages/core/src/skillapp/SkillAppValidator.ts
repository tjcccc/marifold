import { parse } from 'smol-toml';
import {
  DEFAULT_SKILLAPP_PERMISSIONS,
  SKILLAPP_KNOWN_TOOLS,
  SKILLAPP_SCHEMA,
  SkillAppAction,
  SkillAppActionKind,
  SkillAppComponent,
  SkillAppDefinition,
  SkillAppFilesPermission,
  SkillAppInfo,
  SkillAppLayoutItem,
  SkillAppPermissions,
  SkillAppVariable,
  SkillAppVariableRole,
  SkillAppVariableType,
} from './SkillAppSchema';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
const VARIABLE_TYPES = new Set<SkillAppVariableType>(['string', 'number', 'boolean', 'enum']);
const VARIABLE_ROLES = new Set<SkillAppVariableRole>(['input', 'output', 'state']);
const COMPONENTS = new Set<SkillAppComponent>([
  'text', 'text_input', 'textarea', 'select', 'preview', 'tabs', 'file_picker', 'button', 'download_button',
]);
const ACTION_KINDS = new Set<SkillAppActionKind>(['model', 'profile', 'tool']);
const FILES_PERMISSIONS = new Set<SkillAppFilesPermission>(['none', 'read', 'write']);

export interface SkillAppValidationResult {
  ok: boolean;
  definition?: SkillAppDefinition;
  errors: string[];
}

/** Parse and validate a SkillApp TOML document (docs/skillapp.md, v0 rules). */
export function validateSkillAppToml(source: string): SkillAppValidationResult {
  let raw: Record<string, unknown>;
  try {
    raw = parse(source) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, errors: [`Invalid TOML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateSkillApp(raw);
}

export function validateSkillApp(raw: Record<string, unknown>): SkillAppValidationResult {
  const errors: string[] = [];

  if (raw.schema !== SKILLAPP_SCHEMA) {
    errors.push(`schema must be "${SKILLAPP_SCHEMA}".`);
  }

  const app = readApp(raw.app, errors);
  const variables = readVariables(raw.variables, errors);
  const permissions = readPermissions(raw.permissions, errors);
  const actions = readActions(raw.actions, variables, permissions, errors);
  const layout = readLayout(raw.layout, variables, actions, permissions, errors, true);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    definition: { schema: SKILLAPP_SCHEMA, app: app!, variables, layout, actions, permissions },
  };
}

function readApp(value: unknown, errors: string[]): SkillAppInfo | undefined {
  const app = asTable(value);
  if (!app) {
    errors.push('[app] table is required.');
    return undefined;
  }
  const name = asString(app.name);
  const title = asString(app.title);
  if (!name || !KEBAB_CASE.test(name)) errors.push('app.name is required and must be kebab-case.');
  if (!title) errors.push('app.title is required.');
  const description = asString(app.description);
  if (!name || !title) return undefined;
  return { name, title, ...(description ? { description } : {}) };
}

function readVariables(value: unknown, errors: string[]): SkillAppVariable[] {
  const items = asArrayOfTables(value);
  if (!items || items.length === 0) {
    errors.push('At least one [[variables]] entry is required.');
    return [];
  }
  const seen = new Set<string>();
  const variables: SkillAppVariable[] = [];
  items.forEach((item, index) => {
    const label = `variables[${index}]`;
    const name = asString(item.name);
    if (!name || !SNAKE_CASE.test(name)) {
      errors.push(`${label}.name is required and must be snake_case.`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate variable name '${name}'.`);
      return;
    }
    seen.add(name);

    const type = asString(item.type) as SkillAppVariableType | undefined;
    if (!type || !VARIABLE_TYPES.has(type)) {
      errors.push(`${label}.type must be string, number, boolean, or enum.`);
      return;
    }
    const role = asString(item.role) as SkillAppVariableRole | undefined;
    if (!role || !VARIABLE_ROLES.has(role)) {
      errors.push(`${label}.role must be input, output, or state.`);
      return;
    }

    const options = item.options;
    if (type === 'enum') {
      if (!Array.isArray(options) || options.length === 0 || !options.every(o => typeof o === 'string')) {
        errors.push(`${label}.options must be a non-empty string array for enum variables.`);
        return;
      }
    } else if (options !== undefined) {
      errors.push(`${label}.options is only allowed for enum variables.`);
      return;
    }

    const variable: SkillAppVariable = {
      name,
      type,
      role,
      ...(asString(item.label) ? { label: asString(item.label) } : {}),
      ...(item.default !== undefined ? { default: item.default as string | number | boolean } : {}),
      ...(type === 'enum' ? { options: options as string[] } : {}),
    };
    if (variable.default !== undefined && !defaultMatchesType(variable)) {
      errors.push(`${label}.default does not match type '${type}'.`);
      return;
    }
    variables.push(variable);
  });
  return variables;
}

function defaultMatchesType(variable: SkillAppVariable): boolean {
  const value = variable.default;
  switch (variable.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && (variable.options ?? []).includes(value);
  }
}

function readPermissions(value: unknown, errors: string[]): SkillAppPermissions {
  const table = asTable(value);
  if (!table) return { ...DEFAULT_SKILLAPP_PERMISSIONS };

  const files = table.files === undefined ? DEFAULT_SKILLAPP_PERMISSIONS.files : asString(table.files) as SkillAppFilesPermission;
  if (!FILES_PERMISSIONS.has(files)) {
    errors.push('permissions.files must be "none", "read", or "write".');
  }
  const readBool = (key: 'provider_calls' | 'shell' | 'network' | 'export', fallback: boolean): boolean => {
    const raw = table[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'boolean') {
      errors.push(`permissions.${key} must be a boolean.`);
      return fallback;
    }
    return raw;
  };

  return {
    providerCalls: readBool('provider_calls', DEFAULT_SKILLAPP_PERMISSIONS.providerCalls),
    files: FILES_PERMISSIONS.has(files) ? files : DEFAULT_SKILLAPP_PERMISSIONS.files,
    shell: readBool('shell', DEFAULT_SKILLAPP_PERMISSIONS.shell),
    network: readBool('network', DEFAULT_SKILLAPP_PERMISSIONS.network),
    export: readBool('export', DEFAULT_SKILLAPP_PERMISSIONS.export),
  };
}

function readActions(
  value: unknown,
  variables: SkillAppVariable[],
  permissions: SkillAppPermissions,
  errors: string[],
): SkillAppAction[] {
  const items = asArrayOfTables(value);
  if (!items) return [];
  const variableNames = new Set(variables.map(v => v.name));
  const writableNames = new Set(variables.filter(v => v.role !== 'input').map(v => v.name));
  const seen = new Set<string>();
  const actions: SkillAppAction[] = [];

  items.forEach((item, index) => {
    const label = `actions[${index}]`;
    const name = asString(item.name);
    if (!name || !SNAKE_CASE.test(name)) {
      errors.push(`${label}.name is required and must be snake_case.`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate action name '${name}'.`);
      return;
    }
    seen.add(name);

    const kind = asString(item.kind) as SkillAppActionKind | undefined;
    if (!kind || !ACTION_KINDS.has(kind)) {
      errors.push(`${label}.kind must be model, profile, or tool. ('workflow' is reserved for a future version.)`);
      return;
    }

    const output = asString(item.output);
    if (!output || !variableNames.has(output)) {
      errors.push(`${label}.output must reference a declared variable.`);
      return;
    }
    if (!writableNames.has(output)) {
      errors.push(`${label}.output must reference an output or state variable, not an input.`);
      return;
    }

    const action: SkillAppAction = { name, kind, output };

    if (kind === 'model' || kind === 'profile') {
      if (!permissions.providerCalls) {
        errors.push(`${label} requires permissions.provider_calls = true.`);
        return;
      }
      const prompt = asString(item.prompt);
      if (!prompt) {
        errors.push(`${label}.prompt is required for ${kind} actions.`);
        return;
      }
      checkTemplate(prompt, variableNames, `${label}.prompt`, errors);
      action.prompt = prompt;
      if (kind === 'profile') {
        const profile = asString(item.profile);
        if (!profile) {
          errors.push(`${label}.profile is required for profile actions.`);
          return;
        }
        action.profile = profile;
      }
    } else {
      const tool = asString(item.tool);
      if (!tool || !(SKILLAPP_KNOWN_TOOLS as readonly string[]).includes(tool)) {
        errors.push(`${label}.tool must be one of: ${SKILLAPP_KNOWN_TOOLS.join(', ')}.`);
        return;
      }
      if (!toolPermitted(tool, permissions)) {
        errors.push(`${label} uses tool '${tool}' without the required permission.`);
        return;
      }
      action.tool = tool;
      const input = asTable(item.input);
      if (input) {
        for (const [key, inputValue] of Object.entries(input)) {
          if (typeof inputValue === 'string') checkTemplate(inputValue, variableNames, `${label}.input.${key}`, errors);
        }
        action.input = input as Record<string, string | number | boolean>;
      }
    }

    actions.push(action);
  });
  return actions;
}

function toolPermitted(tool: string, permissions: SkillAppPermissions): boolean {
  switch (tool) {
    case 'read_file': return permissions.files === 'read' || permissions.files === 'write';
    case 'write_file': return permissions.files === 'write';
    case 'shell_exec': return permissions.shell;
    case 'web_search': return permissions.network;
    case 'ask_profile': return permissions.providerCalls;
    default: return false;
  }
}

function readLayout(
  value: unknown,
  variables: SkillAppVariable[],
  actions: SkillAppAction[],
  permissions: SkillAppPermissions,
  errors: string[],
  allowTabs: boolean,
): SkillAppLayoutItem[] {
  const items = asArrayOfTables(value);
  if (!items || items.length === 0) {
    if (allowTabs) errors.push('At least one [[layout]] entry is required.');
    return [];
  }
  const variableByName = new Map(variables.map(v => [v.name, v]));
  const actionNames = new Set(actions.map(a => a.name));
  const layout: SkillAppLayoutItem[] = [];

  items.forEach((item, index) => {
    const label = `layout[${index}]`;
    const component = asString(item.component) as SkillAppComponent | undefined;
    if (!component || !COMPONENTS.has(component)) {
      errors.push(`${label}.component must be one of: ${[...COMPONENTS].join(', ')}.`);
      return;
    }

    const entry: SkillAppLayoutItem = {
      component,
      ...(asString(item.bind) ? { bind: asString(item.bind) } : {}),
      ...(asString(item.label) ? { label: asString(item.label) } : {}),
      ...(asString(item.action) ? { action: asString(item.action) } : {}),
      ...(asString(item.content) ? { content: asString(item.content) } : {}),
      ...(asString(item.format) ? { format: asString(item.format) } : {}),
    };

    switch (component) {
      case 'text':
        if (!entry.content) errors.push(`${label} (text) requires content.`);
        break;
      case 'button':
        if (!entry.action || !actionNames.has(entry.action)) {
          errors.push(`${label} (button) requires action referencing a declared action.`);
        }
        break;
      case 'tabs': {
        if (!allowTabs) {
          errors.push(`${label}: tabs cannot be nested.`);
          break;
        }
        if (!Array.isArray(item.tabs) || item.tabs.length === 0) {
          errors.push(`${label} (tabs) requires a non-empty tabs array.`);
          break;
        }
        entry.tabs = item.tabs.map(tab => readLayout(tab, variables, actions, permissions, errors, false));
        break;
      }
      case 'file_picker':
        if (permissions.files === 'none') errors.push(`${label} (file_picker) requires permissions.files of read or write.`);
        requireBind(entry, variableByName, label, errors);
        break;
      case 'download_button':
        if (!permissions.export) errors.push(`${label} (download_button) requires permissions.export = true.`);
        requireBind(entry, variableByName, label, errors);
        break;
      case 'select': {
        const variable = requireBind(entry, variableByName, label, errors);
        if (variable && variable.type !== 'enum') errors.push(`${label} (select) must bind an enum variable.`);
        break;
      }
      default:
        requireBind(entry, variableByName, label, errors);
        break;
    }

    layout.push(entry);
  });
  return layout;
}

function requireBind(
  entry: SkillAppLayoutItem,
  variables: Map<string, SkillAppVariable>,
  label: string,
  errors: string[],
): SkillAppVariable | undefined {
  if (!entry.bind) {
    errors.push(`${label} (${entry.component}) requires bind.`);
    return undefined;
  }
  const variable = variables.get(entry.bind);
  if (!variable) {
    errors.push(`${label}.bind references unknown variable '${entry.bind}'.`);
    return undefined;
  }
  return variable;
}

function checkTemplate(template: string, variableNames: Set<string>, label: string, errors: string[]): void {
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    if (!variableNames.has(match[1])) {
      errors.push(`${label} references unknown variable '{{${match[1]}}}'.`);
    }
  }
}

function asTable(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function asArrayOfTables(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tables: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const table = asTable(item);
    if (!table) return undefined;
    tables.push(table);
  }
  return tables;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
