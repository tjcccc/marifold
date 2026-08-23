import * as ts from 'typescript-compiler';
import { MarifoldError } from '../errors/MarifoldError';
import {
  SKILL_APP_SCHEMA,
  SkillAppDefinition,
  SkillAppLayoutItem,
  SkillAppModelDefinition,
  SkillAppOperationDefinition,
  SkillAppSkillDefinition,
  SkillAppStateDefinition,
  SkillAppTriggerDefinition,
} from './SkillAppSchema';

const MAX_SOURCE_BYTES = 128 * 1024;
const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_LOCAL_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const ALLOWED_BUILDERS = new Set([
  'App', 'Button', 'Column', 'Row', 'Select', 'Spacer', 'State', 'Textarea',
  'TextResult', 'defineSkillApp', 'registerModel', 'registerSkill', 'trigger', 'useSkill',
]);

type Primitive = string | number | boolean | null;
type Evaluated = Primitive | Evaluated[] | { [key: string]: Evaluated } | TaggedValue;

interface TaggedValue {
  __kind: string;
  name?: string;
  [key: string]: Evaluated | string | undefined;
}

interface CompilationState {
  sourceFile: ts.SourceFile;
  imports: Map<string, string>;
  values: Map<string, Evaluated>;
  states: SkillAppStateDefinition[];
  models: SkillAppModelDefinition[];
  skills: SkillAppSkillDefinition[];
  operations: SkillAppOperationDefinition[];
  triggers: SkillAppTriggerDefinition[];
  template?: { app: Record<string, Evaluated>; ui: TaggedValue };
}

/** Compile the restricted TypeScript authoring syntax into renderer-neutral data.
 * The source is inspected as an AST and is never evaluated or imported. */
export function compileSkillApp(source: string, sourcePath = 'skillapp.ts'): SkillAppDefinition {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw MarifoldError.appInvalid(`SkillApp source exceeds ${MAX_SOURCE_BYTES} bytes.`, sourcePath);
  }
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source.replace(/^﻿/, ''),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    throw invalidAt(sourceFile, diagnostic.start, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), sourcePath);
  }

  const state: CompilationState = {
    sourceFile,
    imports: new Map(),
    values: new Map(),
    states: [],
    models: [],
    skills: [],
    operations: [],
    triggers: [],
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      parseImport(statement, state, sourcePath);
    } else if (ts.isVariableStatement(statement)) {
      parseVariables(statement, state, sourcePath);
    } else if (ts.isExpressionStatement(statement)) {
      const expression = unwrap(statement.expression);
      if (!ts.isCallExpression(expression) || builderName(expression.expression, state) !== 'trigger') {
        throw invalidAt(sourceFile, statement.pos, 'Only a top-level trigger(...) call is allowed as an expression.', sourcePath);
      }
      evaluateCall(expression, state, sourcePath);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (state.template) throw invalidAt(sourceFile, statement.pos, 'Only one default export is allowed.', sourcePath);
      const value = evaluateExpression(statement.expression, state, sourcePath);
      const tagged = requireTagged(value, 'skillapp', statement.expression, state, sourcePath);
      state.template = {
        app: requireObject(tagged.app, 'defineSkillApp app', statement.expression, state, sourcePath),
        ui: requireTagged(tagged.ui, 'component', statement.expression, state, sourcePath),
      };
    } else if (statement.getText(sourceFile).trim() !== '') {
      throw invalidAt(sourceFile, statement.pos, 'SkillApp templates allow imports, const declarations, trigger(...), and one default export only.', sourcePath);
    }
  }

  if (!state.template) throw MarifoldError.appInvalid('SkillApp must export default defineSkillApp({...}).', sourcePath);
  const app = normalizeAppInfo(state.template.app, state, sourcePath);
  const layoutRoot = normalizeComponent(state.template.ui, state, sourcePath);
  if (layoutRoot.component !== 'app') {
    throw MarifoldError.appInvalid('defineSkillApp.ui must be App([...]).', sourcePath);
  }
  validateReferences(state, layoutRoot.children ?? [], sourcePath);
  return {
    schema: SKILL_APP_SCHEMA,
    app,
    states: state.states,
    models: state.models,
    skills: state.skills,
    operations: state.operations,
    triggers: state.triggers,
    layout: layoutRoot.children ?? [],
  };
}

function parseImport(node: ts.ImportDeclaration, state: CompilationState, sourcePath: string): void {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== '@marifold/core') {
    throw invalidAt(state.sourceFile, node.pos, 'SkillApp may import builders only from "@marifold/core".', sourcePath);
  }
  const clause = node.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    throw invalidAt(state.sourceFile, node.pos, 'Use named SkillApp builder imports.', sourcePath);
  }
  for (const element of clause.namedBindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    if (!ALLOWED_BUILDERS.has(imported)) {
      throw invalidAt(state.sourceFile, element.pos, `'${imported}' is not an allowed SkillApp builder.`, sourcePath);
    }
    state.imports.set(element.name.text, imported);
  }
}

function parseVariables(node: ts.VariableStatement, state: CompilationState, sourcePath: string): void {
  if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) {
    throw invalidAt(state.sourceFile, node.pos, 'SkillApp declarations must use const.', sourcePath);
  }
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
      throw invalidAt(state.sourceFile, declaration.pos, 'SkillApp const declarations require a simple name and initializer.', sourcePath);
    }
    const name = declaration.name.text;
    if (!SAFE_LOCAL_NAME.test(name) || state.values.has(name)) {
      throw invalidAt(state.sourceFile, declaration.pos, `Invalid or duplicate declaration '${name}'.`, sourcePath);
    }
    const value = evaluateExpression(declaration.initializer, state, sourcePath, name);
    if (isTagged(value)) value.name = name;
    state.values.set(name, value);
    registerDeclaration(name, value, declaration, state, sourcePath);
  }
}

function registerDeclaration(
  name: string,
  value: Evaluated,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): void {
  if (!isTagged(value)) return;
  if (value.__kind === 'state') {
    state.states.push({ name, initial: requireString(value.initial, 'State initial value', node, state, sourcePath) });
  } else if (value.__kind === 'model') {
    const id = requireString(value.id, 'model id', node, state, sourcePath);
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
    state.models.push({
      name,
      provider,
      model,
      think: requireBoolean(value.think, 'model think', node, state, sourcePath),
    });
  } else if (value.__kind === 'skill') {
    const skillName = requireString(value.skillName, 'skill name', node, state, sourcePath);
    if (!SAFE_SKILL_NAME.test(skillName)) {
      throw invalidAt(state.sourceFile, node.pos, `Invalid app-local skill name '${skillName}'.`, sourcePath);
    }
    const result = requireTagged(value.result, 'text_result', node, state, sourcePath);
    state.skills.push({
      name: skillName,
      result: { kind: 'text', trim: requireBoolean(result.trim, 'result trim', node, state, sourcePath) },
    });
  } else if (value.__kind === 'operation') {
    state.operations.push({
      name,
      model: requireNamedReference(value.model, 'model', node, state, sourcePath),
      skill: requireNamedReference(value.skill, 'skill', node, state, sourcePath, true),
      parameters: Object.fromEntries(Object.entries(
        requireObject(value.parameters, 'operation parameters', node, state, sourcePath),
      ).map(([parameter, reference]) => [
        parameter,
        requireNamedReference(reference, 'state', node, state, sourcePath),
      ])),
      requiredInputs: [],
      output: requireNamedReference(value.output, 'state', node, state, sourcePath),
      execution: { memory: false, history: false, profileContext: false },
    });
  }
}

function evaluateExpression(
  rawNode: ts.Expression,
  state: CompilationState,
  sourcePath: string,
  declarationName?: string,
): Evaluated {
  const node = unwrap(rawNode);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isIdentifier(node)) {
    const value = state.values.get(node.text);
    if (value === undefined) throw invalidAt(state.sourceFile, node.pos, `Unknown declaration '${node.text}'.`, sourcePath);
    return value;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(element => {
      if (ts.isSpreadElement(element)) throw invalidAt(state.sourceFile, element.pos, 'Array spreads are not allowed.', sourcePath);
      return evaluateExpression(element, state, sourcePath);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, Evaluated> = Object.create(null) as Record<string, Evaluated>;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name, state, sourcePath);
        if (Object.hasOwn(result, name)) {
          throw invalidAt(state.sourceFile, property.pos, `Duplicate object property '${name}'.`, sourcePath);
        }
        result[name] = evaluateExpression(property.initializer, state, sourcePath);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        if (Object.hasOwn(result, property.name.text)) {
          throw invalidAt(state.sourceFile, property.pos, `Duplicate object property '${property.name.text}'.`, sourcePath);
        }
        const value = state.values.get(property.name.text);
        if (value === undefined) throw invalidAt(state.sourceFile, property.pos, `Unknown declaration '${property.name.text}'.`, sourcePath);
        result[property.name.text] = value;
      } else {
        throw invalidAt(state.sourceFile, property.pos, 'Object methods, accessors, and spreads are not allowed.', sourcePath);
      }
    }
    return result;
  }
  if (ts.isCallExpression(node)) return evaluateCall(node, state, sourcePath, declarationName);
  throw invalidAt(state.sourceFile, node.pos, `Unsupported expression '${ts.SyntaxKind[node.kind]}'.`, sourcePath);
}

function evaluateCall(
  node: ts.CallExpression,
  state: CompilationState,
  sourcePath: string,
  _declarationName?: string,
): TaggedValue {
  const name = builderName(node.expression, state);
  if (!name) throw invalidAt(state.sourceFile, node.pos, 'Only imported SkillApp builders may be called.', sourcePath);
  const args = node.arguments.map(argument => evaluateExpression(argument, state, sourcePath));
  switch (name) {
    case 'State':
      exactArgs(name, args, 1, node, state, sourcePath);
      return { __kind: 'state', initial: requireString(args[0], 'State initial value', node, state, sourcePath) };
    case 'registerModel': {
      argsRange(name, args, 1, 2, node, state, sourcePath);
      const options = args[1] === undefined ? {} : requireObject(args[1], 'registerModel options', node, state, sourcePath);
      rejectUnknown(options, ['think'], name, node, state, sourcePath);
      return {
        __kind: 'model',
        id: requireString(args[0], 'model id', node, state, sourcePath),
        think: options.think === undefined ? false : requireBoolean(options.think, 'think', node, state, sourcePath),
      };
    }
    case 'TextResult': {
      argsRange(name, args, 0, 1, node, state, sourcePath);
      const options = args[0] === undefined ? {} : requireObject(args[0], 'TextResult options', node, state, sourcePath);
      rejectUnknown(options, ['trim'], name, node, state, sourcePath);
      return {
        __kind: 'text_result',
        trim: options.trim === undefined ? false : requireBoolean(options.trim, 'trim', node, state, sourcePath),
      };
    }
    case 'registerSkill': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const options = requireObject(args[1], 'registerSkill options', node, state, sourcePath);
      rejectUnknown(options, ['result'], name, node, state, sourcePath);
      return {
        __kind: 'skill',
        skillName: requireString(args[0], 'skill name', node, state, sourcePath),
        result: requireTagged(options.result, 'text_result', node, state, sourcePath),
      };
    }
    case 'useSkill': {
      exactArgs(name, args, 3, node, state, sourcePath);
      const options = requireObject(args[2], 'useSkill options', node, state, sourcePath);
      rejectUnknown(options, ['parameters', 'output', 'memory', 'history', 'profileContext'], name, node, state, sourcePath);
      for (const key of ['memory', 'history', 'profileContext'] as const) {
        if (options[key] !== false) throw invalidAt(state.sourceFile, node.pos, `useSkill.${key} must be false in v1.`, sourcePath);
      }
      return {
        __kind: 'operation',
        model: requireTagged(args[0], 'model', node, state, sourcePath),
        skill: requireTagged(args[1], 'skill', node, state, sourcePath),
        parameters: requireObject(options.parameters, 'useSkill parameters', node, state, sourcePath),
        output: requireTagged(options.output, 'state', node, state, sourcePath),
      };
    }
    case 'trigger': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const operation = requireTagged(args[0], 'operation', node, state, sourcePath);
      const options = requireObject(args[1], 'trigger options', node, state, sourcePath);
      rejectUnknown(options, ['onChange', 'debounce', 'concurrency'], name, node, state, sourcePath);
      const onChange = requireArray(options.onChange, 'trigger onChange', node, state, sourcePath)
        .map(value => requireNamedReference(value, 'state', node, state, sourcePath));
      if (onChange.length === 0) throw invalidAt(state.sourceFile, node.pos, 'trigger.onChange cannot be empty.', sourcePath);
      const debounce = options.debounce === undefined ? 0 : requireNonNegativeInteger(options.debounce, 'debounce', node, state, sourcePath);
      if (debounce > 60_000) throw invalidAt(state.sourceFile, node.pos, 'trigger.debounce cannot exceed 60000 ms.', sourcePath);
      const concurrency = options.concurrency === undefined
        ? 'latest'
        : requireString(options.concurrency, 'concurrency', node, state, sourcePath);
      if (concurrency !== 'latest') throw invalidAt(state.sourceFile, node.pos, 'trigger.concurrency must be "latest" in v1.', sourcePath);
      state.triggers.push({
        operation: requireName(operation, 'operation', node, state, sourcePath),
        onChange,
        debounce,
        concurrency,
      });
      return { __kind: 'trigger' };
    }
    case 'defineSkillApp': {
      exactArgs(name, args, 1, node, state, sourcePath);
      const template = requireObject(args[0], 'defineSkillApp template', node, state, sourcePath);
      rejectUnknown(template, ['app', 'ui'], name, node, state, sourcePath);
      return {
        __kind: 'skillapp',
        app: requireObject(template.app, 'app metadata', node, state, sourcePath),
        ui: requireTagged(template.ui, 'component', node, state, sourcePath),
      };
    }
    case 'App':
    case 'Column':
    case 'Row': {
      argsRange(name, args, 1, 2, node, state, sourcePath);
      const children = requireArray(args[0], `${name} children`, node, state, sourcePath);
      children.forEach(value => requireTagged(value, 'component', node, state, sourcePath));
      const options = args[1] === undefined ? {} : requireObject(args[1], `${name} options`, node, state, sourcePath);
      const allowed = name === 'Row' ? ['gap', 'responsive'] : name === 'Column' ? ['gap'] : [];
      rejectUnknown(options, allowed, name, node, state, sourcePath);
      return { __kind: 'component', component: name.toLowerCase(), children, options };
    }
    case 'Spacer':
      exactArgs(name, args, 0, node, state, sourcePath);
      return { __kind: 'component', component: 'spacer', options: {} };
    case 'Textarea': {
      argsRange(name, args, 2, 3, node, state, sourcePath);
      const options = args[2] === undefined ? {} : requireObject(args[2], 'Textarea options', node, state, sourcePath);
      rejectUnknown(options, ['showLabel', 'grow', 'editable', 'copyable', 'placeholder'], name, node, state, sourcePath);
      return {
        __kind: 'component', component: 'textarea', label: requireNonEmptyString(args[0], 'Textarea label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath), options,
      };
    }
    case 'Select': {
      exactArgs(name, args, 3, node, state, sourcePath);
      const options = requireObject(args[2], 'Select options', node, state, sourcePath);
      rejectUnknown(options, ['options', 'showLabel', 'grow'], name, node, state, sourcePath);
      const choices = requireArray(options.options, 'Select options.options', node, state, sourcePath)
        .map(value => requireNonEmptyString(value, 'Select option', node, state, sourcePath));
      if (choices.length === 0) throw invalidAt(state.sourceFile, node.pos, 'Select options cannot be empty.', sourcePath);
      return {
        __kind: 'component', component: 'select', label: requireNonEmptyString(args[0], 'Select label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath), options: { ...options, options: choices },
      };
    }
    case 'Button': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const options = requireObject(args[1], 'Button options', node, state, sourcePath);
      rejectUnknown(options, ['trigger', 'emphasis'], name, node, state, sourcePath);
      return {
        __kind: 'component', component: 'button', label: requireNonEmptyString(args[0], 'Button label', node, state, sourcePath),
        operation: requireTagged(options.trigger, 'operation', node, state, sourcePath), options,
      };
    }
  }
  throw invalidAt(state.sourceFile, node.pos, `Unsupported builder '${name}'.`, sourcePath);
}

function normalizeComponent(
  value: TaggedValue,
  state: CompilationState,
  sourcePath: string,
  depth = 0,
): SkillAppLayoutItem {
  if (depth > 4) throw MarifoldError.appInvalid('SkillApp layout depth cannot exceed four.', sourcePath);
  const component = requireString(value.component, 'component name', state.sourceFile, state, sourcePath) as SkillAppLayoutItem['component'];
  const options = requireObject(value.options ?? {}, `${component} options`, state.sourceFile, state, sourcePath);
  const item: SkillAppLayoutItem = { component };
  if (value.children) {
    item.children = requireArray(value.children, `${component} children`, state.sourceFile, state, sourcePath)
      .map(child => normalizeComponent(requireTagged(child, 'component', state.sourceFile, state, sourcePath), state, sourcePath, depth + 1));
  }
  if (value.label !== undefined) item.label = requireString(value.label, `${component} label`, state.sourceFile, state, sourcePath);
  if (value.bind !== undefined) item.bind = requireNamedReference(value.bind, 'state', state.sourceFile, state, sourcePath);
  if (value.operation !== undefined) item.trigger = requireName(requireTagged(value.operation, 'operation', state.sourceFile, state, sourcePath), 'operation', state.sourceFile, state, sourcePath);
  copyBoolean(options, 'showLabel', item, state, sourcePath);
  copyBoolean(options, 'grow', item, state, sourcePath);
  copyBoolean(options, 'editable', item, state, sourcePath);
  copyBoolean(options, 'copyable', item, state, sourcePath);
  copyString(options, 'placeholder', item, state, sourcePath);
  copyString(options, 'gap', item, state, sourcePath);
  copyString(options, 'responsive', item, state, sourcePath);
  copyString(options, 'emphasis', item, state, sourcePath);
  if (options.options !== undefined) {
    item.options = requireArray(options.options, 'Select options', state.sourceFile, state, sourcePath)
      .map(choice => requireString(choice, 'Select option', state.sourceFile, state, sourcePath));
  }
  if (item.component === 'textarea' && item.editable === undefined) item.editable = true;
  if (item.component === 'button' && item.emphasis === undefined) item.emphasis = 'primary';
  if (item.gap !== undefined && !['none', 'small', 'medium', 'large'].includes(item.gap)) {
    throw MarifoldError.appInvalid(`Invalid layout gap '${item.gap}'.`, sourcePath);
  }
  if (item.responsive !== undefined && item.responsive !== 'stack') {
    throw MarifoldError.appInvalid(`Invalid responsive behavior '${item.responsive}'.`, sourcePath);
  }
  if (item.emphasis !== undefined && !['primary', 'secondary'].includes(item.emphasis)) {
    throw MarifoldError.appInvalid(`Invalid button emphasis '${item.emphasis}'.`, sourcePath);
  }
  if (item.options && new Set(item.options).size !== item.options.length) {
    throw MarifoldError.appInvalid('Select options must be unique.', sourcePath);
  }
  return item;
}

function validateReferences(state: CompilationState, layout: SkillAppLayoutItem[], sourcePath: string): void {
  const stateNames = new Set(state.states.map(item => item.name));
  const modelNames = new Set(state.models.map(item => item.name));
  const skillNames = new Set(state.skills.map(item => item.name));
  const operationNames = new Set(state.operations.map(item => item.name));
  assertUnique(state.models.map(item => item.name), 'model declarations', sourcePath);
  assertUnique(state.skills.map(item => item.name), 'registered Skills', sourcePath);
  assertUnique(state.operations.map(item => item.name), 'operations', sourcePath);
  if (state.states.length === 0) throw MarifoldError.appInvalid('SkillApp must declare at least one State.', sourcePath);
  if (state.operations.length === 0) throw MarifoldError.appInvalid('SkillApp must declare at least one useSkill operation.', sourcePath);
  for (const operation of state.operations) {
    if (!modelNames.has(operation.model)) throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing model '${operation.model}'.`, sourcePath);
    if (!skillNames.has(operation.skill)) throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing skill '${operation.skill}'.`, sourcePath);
    if (!stateNames.has(operation.output)) throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing output state '${operation.output}'.`, sourcePath);
    for (const name of Object.values(operation.parameters)) {
      if (!stateNames.has(name)) throw MarifoldError.appInvalid(`Operation '${operation.name}' references missing state '${name}'.`, sourcePath);
    }
  }
  const layoutItems = flatten(layout);
  if (layoutItems.length > 100) throw MarifoldError.appInvalid('SkillApp layout cannot exceed 100 components.', sourcePath);
  for (const item of layoutItems) {
    if (item.component === 'app') throw MarifoldError.appInvalid('App(...) can only be the root UI component.', sourcePath);
    if (item.bind && !stateNames.has(item.bind)) throw MarifoldError.appInvalid(`Layout references missing state '${item.bind}'.`, sourcePath);
    if (item.trigger && !operationNames.has(item.trigger)) throw MarifoldError.appInvalid(`Button references missing operation '${item.trigger}'.`, sourcePath);
    if (item.component === 'select' && item.bind) {
      const initial = state.states.find(candidate => candidate.name === item.bind)?.initial;
      if (initial !== undefined && !(item.options ?? []).includes(initial)) {
        throw MarifoldError.appInvalid(`Select state '${item.bind}' initial value must be one of its options.`, sourcePath);
      }
    }
  }
  for (const triggerDefinition of state.triggers) {
    if (!operationNames.has(triggerDefinition.operation)) throw MarifoldError.appInvalid(`Trigger references missing operation '${triggerDefinition.operation}'.`, sourcePath);
    for (const name of triggerDefinition.onChange) {
      if (!stateNames.has(name)) throw MarifoldError.appInvalid(`Trigger references missing state '${name}'.`, sourcePath);
    }
  }
  const outputStates = new Set(state.operations.map(operation => operation.output));
  for (const operation of state.operations) {
    for (const input of Object.values(operation.parameters)) {
      if (outputStates.has(input)) throw MarifoldError.appInvalid(`Operation '${operation.name}' cannot use output state '${input}' as a parameter in v1.`, sourcePath);
    }
  }
  for (const item of layoutItems) {
    if (!item.bind || !outputStates.has(item.bind)) continue;
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

function assertUnique(values: string[], label: string, sourcePath: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw MarifoldError.appInvalid(`Duplicate ${label}: '${value}'.`, sourcePath);
    seen.add(value);
  }
}

function normalizeAppInfo(raw: Record<string, Evaluated>, state: CompilationState, sourcePath: string) {
  rejectUnknown(raw, ['name', 'title', 'version', 'description'], 'app metadata', state.sourceFile, state, sourcePath);
  const name = requireNonEmptyString(raw.name, 'app.name', state.sourceFile, state, sourcePath);
  if (!SAFE_APP_NAME.test(name)) throw MarifoldError.appInvalid(`Invalid App name '${name}'. Use kebab-case.`, sourcePath);
  return {
    name,
    title: requireNonEmptyString(raw.title, 'app.title', state.sourceFile, state, sourcePath),
    ...(raw.version !== undefined ? { version: requireNonEmptyString(raw.version, 'app.version', state.sourceFile, state, sourcePath) } : {}),
    ...(raw.description !== undefined ? { description: requireString(raw.description, 'app.description', state.sourceFile, state, sourcePath) } : {}),
  };
}

function flatten(items: SkillAppLayoutItem[]): SkillAppLayoutItem[] {
  return items.flatMap(item => [item, ...flatten(item.children ?? [])]);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function builderName(expression: ts.LeftHandSideExpression, state: CompilationState): string | undefined {
  return ts.isIdentifier(expression) ? state.imports.get(expression.text) : undefined;
}

function propertyName(name: ts.PropertyName, state: CompilationState, sourcePath: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw invalidAt(state.sourceFile, name.pos, 'Computed property names are not allowed.', sourcePath);
}

function isTagged(value: Evaluated | undefined): value is TaggedValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__kind' in value;
}

function requireTagged(value: Evaluated | undefined, kind: string, node: ts.Node, state: CompilationState, sourcePath: string): TaggedValue {
  if (isTagged(value) && value.__kind === kind) return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${kind} reference.`, sourcePath);
}

function requireObject(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): Record<string, Evaluated> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isTagged(value)) return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be an object.`, sourcePath);
}

function requireArray(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): Evaluated[] {
  if (Array.isArray(value)) return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be an array.`, sourcePath);
}

function requireString(value: Evaluated | string | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  if (typeof value === 'string') return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a string.`, sourcePath);
}

function requireNonEmptyString(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  const text = requireString(value, label, node, state, sourcePath).trim();
  if (!text) throw invalidAt(state.sourceFile, node.pos, `${label} cannot be empty.`, sourcePath);
  return text;
}

function requireBoolean(value: Evaluated | string | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): boolean {
  if (typeof value === 'boolean') return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a boolean.`, sourcePath);
}

function requireNonNegativeInteger(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a non-negative integer.`, sourcePath);
}

function requireName(value: TaggedValue, kind: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  if (value.name) return value.name;
  throw invalidAt(state.sourceFile, node.pos, `The ${kind} reference must first be assigned to a const.`, sourcePath);
}

function requireNamedReference(
  value: Evaluated | string | undefined,
  kind: string,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
  skillUsesRegisteredName = false,
): string {
  const tagged = requireTagged(value as Evaluated, kind, node, state, sourcePath);
  if (skillUsesRegisteredName) return requireString(tagged.skillName, 'registered skill name', node, state, sourcePath);
  return requireName(tagged, kind, node, state, sourcePath);
}

function exactArgs(name: string, args: Evaluated[], count: number, node: ts.Node, state: CompilationState, sourcePath: string): void {
  argsRange(name, args, count, count, node, state, sourcePath);
}

function argsRange(name: string, args: Evaluated[], min: number, max: number, node: ts.Node, state: CompilationState, sourcePath: string): void {
  if (args.length < min || args.length > max) {
    throw invalidAt(state.sourceFile, node.pos, `${name} expects ${min === max ? String(min) : `${min}-${max}`} argument(s).`, sourcePath);
  }
}

function rejectUnknown(
  object: Record<string, Evaluated>,
  allowed: string[],
  label: string,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): void {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw invalidAt(state.sourceFile, node.pos, `${label} does not support: ${unknown.join(', ')}.`, sourcePath);
}

function copyBoolean(
  source: Record<string, Evaluated>,
  key: 'showLabel' | 'grow' | 'editable' | 'copyable',
  target: SkillAppLayoutItem,
  state: CompilationState,
  sourcePath: string,
): void {
  if (source[key] !== undefined) target[key] = requireBoolean(source[key], key, state.sourceFile, state, sourcePath);
}

function copyString(
  source: Record<string, Evaluated>,
  key: 'placeholder' | 'gap' | 'responsive' | 'emphasis',
  target: SkillAppLayoutItem,
  state: CompilationState,
  sourcePath: string,
): void {
  if (source[key] !== undefined) (target as unknown as Record<string, unknown>)[key] = requireString(source[key], key, state.sourceFile, state, sourcePath);
}

function invalidAt(sourceFile: ts.SourceFile, position: number | undefined, message: string, sourcePath: string): MarifoldError {
  const location = sourceFile.getLineAndCharacterOfPosition(Math.max(0, position ?? 0));
  return MarifoldError.appInvalid(`${message} (${location.line + 1}:${location.character + 1})`, sourcePath);
}
