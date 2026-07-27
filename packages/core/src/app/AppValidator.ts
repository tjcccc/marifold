import { parse } from 'smol-toml';
import {
  DEFAULT_APP_EXECUTION,
  DEFAULT_APP_PERMISSIONS,
  APP_SCHEMA,
  AppAction,
  AppActionKind,
  AppActor,
  AppComponent,
  AppDefinition,
  AppExecution,
  AppFilesPermission,
  AppInfo,
  AppLayoutGap,
  AppLayoutItem,
  AppPermissions,
  AppResponsiveBehavior,
  AppVariable,
  AppVariableRole,
  AppVariableType,
} from './AppSchema';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
const VARIABLE_TYPES = new Set<AppVariableType>(['string', 'number', 'boolean', 'enum']);
const VARIABLE_ROLES = new Set<AppVariableRole>(['input', 'output', 'state']);
const COMPONENTS = new Set<AppComponent>([
  'row', 'column', 'spacer', 'text', 'text_input', 'textarea', 'select', 'preview', 'tabs', 'file_picker', 'button',
  'download_button',
]);
const ACTION_KINDS = new Set<AppActionKind>(['skill']);
const FILES_PERMISSIONS = new Set<AppFilesPermission>(['none', 'read', 'write']);
const LAYOUT_GAPS = new Set<AppLayoutGap>(['none', 'small', 'medium', 'large']);
const RESPONSIVE_BEHAVIORS = new Set<AppResponsiveBehavior>(['stack']);
const MAX_LAYOUT_DEPTH = 4;
const MAX_LAYOUT_ITEMS = 100;

export interface AppValidationResult {
  ok: boolean;
  definition?: AppDefinition;
  errors: string[];
}

/** Parse and validate an App TOML document (docs/app.md, v0 rules). */
export function validateAppToml(source: string): AppValidationResult {
  let raw: Record<string, unknown>;
  try {
    raw = parse(source) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, errors: [`Invalid TOML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateApp(raw);
}

export function validateApp(raw: Record<string, unknown>): AppValidationResult {
  const errors: string[] = [];

  if (raw.schema !== APP_SCHEMA) {
    errors.push(`schema must be "${APP_SCHEMA}".`);
  }

  const app = readApp(raw.app, errors);
  const actors = readActors(raw.actors, errors);
  const variables = readVariables(raw.variables, errors);
  const execution = readExecution(raw.execution, errors);
  const permissions = readPermissions(raw.permissions, errors);
  const actions = readActions(raw.actions, actors, variables, permissions, errors);
  const layout = readLayout(raw.layout, variables, actions, permissions, errors, {
    depth: 0,
    insideTabs: false,
    count: { value: 0 },
    path: 'layout',
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    definition: { schema: APP_SCHEMA, app: app!, actors, variables, layout, actions, execution, permissions },
  };
}

function readApp(value: unknown, errors: string[]): AppInfo | undefined {
  const app = asTable(value);
  if (!app) {
    errors.push('[app] table is required.');
    return undefined;
  }
  const name = asString(app.name);
  const title = asString(app.title);
  if (!name || !KEBAB_CASE.test(name)) errors.push('app.name is required and must be kebab-case.');
  if (!title) errors.push('app.title is required.');
  const version = asString(app.version);
  if (version && !SEMVER.test(version)) errors.push('app.version must use Semantic Versioning without a "v" prefix.');
  const description = asString(app.description);
  if (!name || !title) return undefined;
  return {
    name,
    title,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
  };
}

function readActors(value: unknown, errors: string[]): AppActor[] {
  const items = asArrayOfTables(value);
  if (!items) return [];
  const seen = new Set<string>();
  const actors: AppActor[] = [];
  items.forEach((item, index) => {
    const label = `actors[${index}]`;
    const name = asString(item.name);
    if (!name || !SNAKE_CASE.test(name)) {
      errors.push(`${label}.name is required and must be snake_case.`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate actor name '${name}'.`);
      return;
    }
    seen.add(name);
    const profile = asString(item.profile);
    if (!profile || !PROFILE_NAME.test(profile)) {
      errors.push(`${label}.profile is required and must be a valid profile name.`);
      return;
    }
    actors.push({
      name,
      profile,
      ...(asString(item.label) ? { label: asString(item.label) } : {}),
    });
  });
  return actors;
}

function readVariables(value: unknown, errors: string[]): AppVariable[] {
  const items = asArrayOfTables(value);
  if (!items || items.length === 0) {
    errors.push('At least one [[variables]] entry is required.');
    return [];
  }
  const seen = new Set<string>();
  const variables: AppVariable[] = [];
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

    const type = asString(item.type) as AppVariableType | undefined;
    if (!type || !VARIABLE_TYPES.has(type)) {
      errors.push(`${label}.type must be string, number, boolean, or enum.`);
      return;
    }
    const role = asString(item.role) as AppVariableRole | undefined;
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

    const variable: AppVariable = {
      name,
      type,
      role,
      ...(asString(item.label) ? { label: asString(item.label) } : {}),
      ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
      ...(item.default !== undefined ? { default: item.default as AppVariable['default'] } : {}),
      ...(type === 'enum' ? { options: options as string[] } : {}),
    };
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      errors.push(`${label}.required must be a boolean.`);
      return;
    }
    if (variable.default !== undefined && !defaultMatchesType(variable)) {
      errors.push(`${label}.default does not match type '${type}'.`);
      return;
    }
    variables.push(variable);
  });
  return variables;
}

function defaultMatchesType(variable: AppVariable): boolean {
  const value = variable.default;
  switch (variable.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && (variable.options ?? []).includes(value);
  }
}

function readExecution(value: unknown, errors: string[]): AppExecution {
  const table = asTable(value);
  if (!table) return { ...DEFAULT_APP_EXECUTION };
  const readBool = (
    key: 'think' | 'memory' | 'profile_context',
    fallback: boolean,
  ): boolean => {
    const raw = table[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'boolean') {
      errors.push(`execution.${key} must be a boolean.`);
      return fallback;
    }
    return raw;
  };
  if (table.history !== undefined) {
    errors.push('execution.history is not supported; App actions never use Agent transcripts.');
  }
  return {
    think: readBool('think', DEFAULT_APP_EXECUTION.think),
    memory: readBool('memory', DEFAULT_APP_EXECUTION.memory),
    profileContext: readBool('profile_context', DEFAULT_APP_EXECUTION.profileContext),
  };
}

function readPermissions(value: unknown, errors: string[]): AppPermissions {
  const table = asTable(value);
  if (!table) return { ...DEFAULT_APP_PERMISSIONS };

  const files = table.files === undefined ? DEFAULT_APP_PERMISSIONS.files : asString(table.files) as AppFilesPermission;
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
    providerCalls: readBool('provider_calls', DEFAULT_APP_PERMISSIONS.providerCalls),
    files: FILES_PERMISSIONS.has(files) ? files : DEFAULT_APP_PERMISSIONS.files,
    shell: readBool('shell', DEFAULT_APP_PERMISSIONS.shell),
    network: readBool('network', DEFAULT_APP_PERMISSIONS.network),
    export: readBool('export', DEFAULT_APP_PERMISSIONS.export),
  };
}

function readActions(
  value: unknown,
  actors: AppActor[],
  variables: AppVariable[],
  permissions: AppPermissions,
  errors: string[],
): AppAction[] {
  const items = asArrayOfTables(value);
  if (!items) return [];
  const actorNames = new Set(actors.map(actor => actor.name));
  const variableNames = new Set(variables.map(v => v.name));
  const writableNames = new Set(variables.filter(v => v.role !== 'input').map(v => v.name));
  const seen = new Set<string>();
  const actions: AppAction[] = [];

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

    const kind = asString(item.kind) as AppActionKind | undefined;
    if (!kind || !ACTION_KINDS.has(kind)) {
      errors.push(`${label}.kind must be skill.`);
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

    if (!permissions.providerCalls) {
      errors.push(`${label} requires permissions.provider_calls = true.`);
      return;
    }
    const actor = asString(item.actor);
    if (!actor || !actorNames.has(actor)) {
      errors.push(`${label}.actor must reference a declared actor.`);
      return;
    }
    const skill = asString(item.skill);
    if (!skill || !SKILL_NAME.test(skill)) {
      errors.push(`${label}.skill is required and must be a valid skill name.`);
      return;
    }
    const argumentsTable = asTable(item.arguments);
    if (!argumentsTable) {
      errors.push(`${label}.arguments is required for skill actions.`);
      return;
    }
    const actionArguments: AppAction['arguments'] = {};
    for (const [key, argumentValue] of Object.entries(argumentsTable)) {
      if (!SNAKE_CASE.test(key)) {
        errors.push(`${label}.arguments key '${key}' must be snake_case.`);
        continue;
      }
      if (!isVariableValue(argumentValue)) {
        errors.push(`${label}.arguments.${key} must be a string, number, or boolean.`);
        continue;
      }
      if (typeof argumentValue === 'string') {
        checkTemplate(argumentValue, variableNames, `${label}.arguments.${key}`, errors);
      }
      actionArguments[key] = argumentValue;
    }
    actions.push({ name, kind, actor, skill, arguments: actionArguments, output });
  });
  return actions;
}

interface LayoutReadContext {
  depth: number;
  insideTabs: boolean;
  count: { value: number };
  path: string;
}

function readLayout(
  value: unknown,
  variables: AppVariable[],
  actions: AppAction[],
  permissions: AppPermissions,
  errors: string[],
  context: LayoutReadContext,
): AppLayoutItem[] {
  if (context.depth > MAX_LAYOUT_DEPTH) {
    errors.push(`${context.path} exceeds the maximum layout depth of ${MAX_LAYOUT_DEPTH}.`);
    return [];
  }
  const items = asArrayOfTables(value);
  if (!items || items.length === 0) {
    errors.push(`${context.path} must contain at least one layout item.`);
    return [];
  }
  const variableByName = new Map(variables.map(v => [v.name, v]));
  const actionNames = new Set(actions.map(a => a.name));
  const layout: AppLayoutItem[] = [];

  items.forEach((item, index) => {
    const label = `${context.path}[${index}]`;
    context.count.value += 1;
    if (context.count.value > MAX_LAYOUT_ITEMS) {
      if (context.count.value === MAX_LAYOUT_ITEMS + 1) {
        errors.push(`Layout exceeds the maximum of ${MAX_LAYOUT_ITEMS} items.`);
      }
      return;
    }
    const component = asString(item.component) as AppComponent | undefined;
    if (!component || !COMPONENTS.has(component)) {
      errors.push(`${label}.component must be one of: ${[...COMPONENTS].join(', ')}.`);
      return;
    }

    const gap = asString(item.gap) as AppLayoutGap | undefined;
    if (gap && !LAYOUT_GAPS.has(gap)) errors.push(`${label}.gap must be none, small, medium, or large.`);
    const responsive = asString(item.responsive) as AppResponsiveBehavior | undefined;
    if (responsive && !RESPONSIVE_BEHAVIORS.has(responsive)) {
      errors.push(`${label}.responsive must be stack.`);
    }
    if (item.grow !== undefined && typeof item.grow !== 'boolean') {
      errors.push(`${label}.grow must be a boolean.`);
    }
    if (item.show_label !== undefined && typeof item.show_label !== 'boolean') {
      errors.push(`${label}.show_label must be a boolean.`);
    }
    const labelControl = component === 'text_input' || component === 'textarea' || component === 'select';
    if (item.show_label !== undefined && !labelControl) {
      errors.push(`${label}.show_label is only allowed on text_input, textarea, or select.`);
    }

    const entry: AppLayoutItem = {
      component,
      ...(asString(item.bind) ? { bind: asString(item.bind) } : {}),
      ...(asString(item.label) ? { label: asString(item.label) } : {}),
      ...(asString(item.action) ? { action: asString(item.action) } : {}),
      ...(asString(item.content) ? { content: asString(item.content) } : {}),
      ...(asString(item.format) ? { format: asString(item.format) } : {}),
      ...(typeof item.show_label === 'boolean' ? { showLabel: item.show_label } : {}),
      ...(gap && LAYOUT_GAPS.has(gap) ? { gap } : {}),
      ...(responsive && RESPONSIVE_BEHAVIORS.has(responsive) ? { responsive } : {}),
      ...(typeof item.grow === 'boolean' ? { grow: item.grow } : {}),
    };

    switch (component) {
      case 'row':
      case 'column': {
        const children = asArrayOfTables(item.children);
        if (!children || children.length === 0) {
          errors.push(`${label} (${component}) requires a non-empty children array.`);
          break;
        }
        entry.children = readLayout(children, variables, actions, permissions, errors, {
          ...context,
          depth: context.depth + 1,
          path: `${label}.children`,
        });
        break;
      }
      case 'spacer':
        break;
      case 'text':
        if (!entry.content) errors.push(`${label} (text) requires content.`);
        break;
      case 'button':
        if (!entry.action || !actionNames.has(entry.action)) {
          errors.push(`${label} (button) requires action referencing a declared action.`);
        }
        break;
      case 'tabs': {
        if (context.insideTabs) {
          errors.push(`${label}: tabs cannot be nested.`);
          break;
        }
        if (!Array.isArray(item.tabs) || item.tabs.length === 0) {
          errors.push(`${label} (tabs) requires a non-empty tabs array.`);
          break;
        }
        entry.tabs = item.tabs.map((tab, tabIndex) => readLayout(
          tab,
          variables,
          actions,
          permissions,
          errors,
          {
            ...context,
            depth: context.depth + 1,
            insideTabs: true,
            path: `${label}.tabs[${tabIndex}]`,
          },
        ));
        break;
      }
      case 'file_picker': {
        if (permissions.files === 'none') errors.push(`${label} (file_picker) requires permissions.files of read or write.`);
        const variable = requireBind(entry, variableByName, label, errors);
        requireWritableVariable(variable, label, errors);
        break;
      }
      case 'download_button':
        if (!permissions.export) errors.push(`${label} (download_button) requires permissions.export = true.`);
        requireBind(entry, variableByName, label, errors);
        break;
      case 'select': {
        const variable = requireBind(entry, variableByName, label, errors);
        if (variable && variable.type !== 'enum') errors.push(`${label} (select) must bind an enum variable.`);
        requireWritableVariable(variable, label, errors);
        break;
      }
      case 'textarea': {
        const variable = requireBind(entry, variableByName, label, errors);
        if (variable && variable.type !== 'string') errors.push(`${label} (textarea) must bind a string variable.`);
        requireWritableVariable(variable, label, errors);
        break;
      }
      case 'text_input': {
        const variable = requireBind(entry, variableByName, label, errors);
        if (variable && variable.type !== 'string' && variable.type !== 'number') {
          errors.push(`${label} (text_input) must bind a string or number variable.`);
        }
        requireWritableVariable(variable, label, errors);
        break;
      }
      case 'preview':
        if (entry.format && entry.format !== 'text' && entry.format !== 'markdown') {
          errors.push(`${label} (preview) format must be text or markdown.`);
        }
        requireBind(entry, variableByName, label, errors);
        break;
    }

    layout.push(entry);
  });
  return layout;
}

function requireWritableVariable(
  variable: AppVariable | undefined,
  label: string,
  errors: string[],
): void {
  if (variable?.role === 'output') {
    errors.push(`${label} cannot edit output variable '${variable.name}'. Use preview instead.`);
  }
}

function requireBind(
  entry: AppLayoutItem,
  variables: Map<string, AppVariable>,
  label: string,
  errors: string[],
): AppVariable | undefined {
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

function isVariableValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
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
