import * as ts from 'typescript-compiler';
import { MarifoldError } from '../errors/MarifoldError';
import { SKILL_APP_PROFILE_SCHEMA, SKILL_APP_SCHEMA, type SkillAppDefinition, type SkillAppLayoutItem } from './SkillAppSchema';
import { argsRange, builderName, type CompilationState, copyBoolean, copyString, type Evaluated, exactArgs, invalidAt, isTagged, propertyName, rejectUnknown, requireArray, requireBoolean, requireName, requireNamedReference, requireNonEmptyString, requireNonNegativeInteger, requireObject, requireSelectOption, requireSkillOptionValues, requireString, requireTagged, SAFE_SKILL_NAME, selectOptionValue, type TaggedValue, unwrap } from './SkillAppCompilerSupport';
import { normalizeAppInfo, normalizePermissions, parseModelId, validateReferences } from './SkillAppValidation';

const MAX_SOURCE_BYTES = 128 * 1024;
const SAFE_LOCAL_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_DOWNLOAD_FILENAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/;
const SAFE_DOWNLOAD_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*charset=[a-z0-9._-]+)?$/i;

const ALLOWED_BUILDERS = new Set([
  'App', 'AttachmentState', 'Attachments', 'Button', 'Column', 'Download', 'FileAccess',
  'FolderAccess', 'Markdown', 'Row', 'Select', 'Spacer', 'State', 'Textarea',
  'TextResult', 'defineSkillApp', 'registerModel', 'registerProfile', 'registerSkill',
  'trigger', 'useProfileSkill', 'useSkill',
]);

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
    attachmentStates: [],
    models: [],
    profiles: [],
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
      if (state.template) { throw invalidAt(sourceFile, statement.pos, 'Only one default export is allowed.', sourcePath); }
      const value = evaluateExpression(statement.expression, state, sourcePath);
      const tagged = requireTagged(value, 'skillapp', statement.expression, state, sourcePath);
      state.template = {
        app: requireObject(tagged.app, 'defineSkillApp app', statement.expression, state, sourcePath),
        permissions: requireArray(tagged.permissions ?? [], 'defineSkillApp permissions', statement.expression, state, sourcePath)
          .map(permission => requireTagged(permission, 'permission', statement.expression, state, sourcePath)),
        ui: requireTagged(tagged.ui, 'component', statement.expression, state, sourcePath),
      };
    } else if (statement.getText(sourceFile).trim() !== '') {
      throw invalidAt(sourceFile, statement.pos, 'SkillApp templates allow imports, const declarations, trigger(...), and one default export only.', sourcePath);
    }
  }

  if (!state.template) { throw MarifoldError.appInvalid('SkillApp must export default defineSkillApp({...}).', sourcePath); }
  const app = normalizeAppInfo(state.template.app, state, sourcePath);
  const permissions = normalizePermissions(state.template.permissions, state, sourcePath);
  const layoutRoot = normalizeComponent(state.template.ui, state, sourcePath);
  if (layoutRoot.component !== 'app') {
    throw MarifoldError.appInvalid('defineSkillApp.ui must be App([...]).', sourcePath);
  }
  validateReferences(state, layoutRoot.children ?? [], sourcePath);
  return {
    schema: state.profiles.length > 0 ? SKILL_APP_PROFILE_SCHEMA : SKILL_APP_SCHEMA,
    app,
    states: state.states,
    attachmentStates: state.attachmentStates,
    permissions,
    models: state.models,
    profiles: state.profiles,
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
    if (isTagged(value)) { value.name = name; }
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
  if (!isTagged(value)) { return; }
  if (value.__kind === 'state') {
    state.states.push({ name, initial: requireString(value.initial, 'State initial value', node, state, sourcePath) });
  } else if (value.__kind === 'attachment_state') {
    state.attachmentStates.push({ name });
  } else if (value.__kind === 'model') {
    const id = requireString(value.id, 'model id', node, state, sourcePath);
    const { provider, model } = parseModelId(id, node, state, sourcePath);
    state.models.push({
      name,
      provider,
      model,
      think: requireBoolean(value.think, 'model think', node, state, sourcePath),
    });
  } else if (value.__kind === 'profile') {
    const profile = requireString(value.profileName, 'profile name', node, state, sourcePath);
    if (!SAFE_PROFILE_NAME.test(profile)) {
      throw invalidAt(state.sourceFile, node.pos, `Invalid profile name '${profile}'.`, sourcePath);
    }
    const modelId = value.modelId === undefined
      ? undefined
      : requireString(value.modelId, 'profile model override', node, state, sourcePath);
    const modelOverride = modelId === undefined
      ? undefined
      : parseModelId(modelId, node, state, sourcePath);
    state.profiles.push({
      name,
      profile,
      ...(modelOverride ?? {}),
      ...(value.think !== undefined
        ? { think: requireBoolean(value.think, 'profile think', node, state, sourcePath) }
        : {}),
      memory: requireBoolean(value.memory, 'profile memory', node, state, sourcePath),
      history: requireBoolean(value.history, 'profile history', node, state, sourcePath),
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
    const parameters = Object.fromEntries(Object.entries(
      requireObject(value.parameters, 'operation parameters', node, state, sourcePath),
    ).map(([parameter, reference]) => [
      parameter,
      requireNamedReference(reference, 'state', node, state, sourcePath),
    ]));
    if (value.profile !== undefined) {
      const profile = requireTagged(value.profile, 'profile', node, state, sourcePath);
      const result = requireTagged(value.result, 'text_result', node, state, sourcePath);
      const skillName = value.skillName === undefined
        ? undefined
        : requireString(value.skillName, 'profile skill name', node, state, sourcePath);
      const skillState = value.skillState === undefined
        ? undefined
        : requireNamedReference(value.skillState, 'state', node, state, sourcePath);
      const skillOptions = value.skillOptions === undefined
        ? undefined
        : requireSkillOptionValues(value.skillOptions, node, state, sourcePath);
      state.operations.push({
        name,
        profile: requireName(profile, 'profile', node, state, sourcePath),
        ...(skillName ? { skill: skillName } : {}),
        ...(skillState ? { skillState } : {}),
        ...(skillOptions ? { skillOptions } : {}),
        ...(value.stripSkillName !== undefined
          ? { stripSkillName: requireBoolean(value.stripSkillName, 'stripSkillName', node, state, sourcePath) }
          : {}),
        ...(value.input !== undefined
          ? { input: requireNamedReference(value.input, 'state', node, state, sourcePath) }
          : {}),
        ...(value.attachments !== undefined
          ? { attachments: requireNamedReference(value.attachments, 'attachment_state', node, state, sourcePath) }
          : {}),
        parameters,
        requiredInputs: [],
        output: requireNamedReference(value.output, 'state', node, state, sourcePath),
        result: {
          kind: 'text',
          trim: requireBoolean(result.trim, 'result trim', node, state, sourcePath),
        },
        ...(value.interactive !== undefined
          ? { interactive: requireBoolean(value.interactive, 'interactive', node, state, sourcePath) }
          : {}),
        execution: {
          memory: requireBoolean(profile.memory, 'profile memory', node, state, sourcePath),
          history: requireBoolean(profile.history, 'profile history', node, state, sourcePath),
          profileContext: true,
        },
      });
    } else {
      state.operations.push({
        name,
        model: requireNamedReference(value.model, 'model', node, state, sourcePath),
        skill: requireNamedReference(value.skill, 'skill', node, state, sourcePath, true),
        parameters,
        requiredInputs: [],
        output: requireNamedReference(value.output, 'state', node, state, sourcePath),
        execution: { memory: false, history: false, profileContext: false },
      });
    }
  }
}

function evaluateExpression(
  rawNode: ts.Expression,
  state: CompilationState,
  sourcePath: string,
  declarationName?: string,
): Evaluated {
  const node = unwrap(rawNode);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { return node.text; }
  if (ts.isNumericLiteral(node)) { return Number(node.text); }
  if (node.kind === ts.SyntaxKind.TrueKeyword) { return true; }
  if (node.kind === ts.SyntaxKind.FalseKeyword) { return false; }
  if (node.kind === ts.SyntaxKind.NullKeyword) { return null; }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isIdentifier(node)) {
    const value = state.values.get(node.text);
    if (value === undefined) { throw invalidAt(state.sourceFile, node.pos, `Unknown declaration '${node.text}'.`, sourcePath); }
    return value;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(element => {
      if (ts.isSpreadElement(element)) { throw invalidAt(state.sourceFile, element.pos, 'Array spreads are not allowed.', sourcePath); }
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
        if (value === undefined) { throw invalidAt(state.sourceFile, property.pos, `Unknown declaration '${property.name.text}'.`, sourcePath); }
        result[property.name.text] = value;
      } else {
        throw invalidAt(state.sourceFile, property.pos, 'Object methods, accessors, and spreads are not allowed.', sourcePath);
      }
    }
    return result;
  }
  if (ts.isCallExpression(node)) { return evaluateCall(node, state, sourcePath, declarationName); }
  throw invalidAt(state.sourceFile, node.pos, `Unsupported expression '${ts.SyntaxKind[node.kind]}'.`, sourcePath);
}

function evaluateCall(
  node: ts.CallExpression,
  state: CompilationState,
  sourcePath: string,
  _declarationName?: string,
): TaggedValue {
  const name = builderName(node.expression, state);
  if (!name) { throw invalidAt(state.sourceFile, node.pos, 'Only imported SkillApp builders may be called.', sourcePath); }
  const args = node.arguments.map(argument => evaluateExpression(argument, state, sourcePath));
  switch (name) {
    case 'State':
      exactArgs(name, args, 1, node, state, sourcePath);
      return { __kind: 'state', initial: requireString(args[0], 'State initial value', node, state, sourcePath) };
    case 'AttachmentState':
      exactArgs(name, args, 0, node, state, sourcePath);
      return { __kind: 'attachment_state' };
    case 'FileAccess':
    case 'FolderAccess': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const options = requireObject(args[1], `${name} options`, node, state, sourcePath);
      rejectUnknown(options, ['access'], name, node, state, sourcePath);
      const access = requireString(options.access, `${name} access`, node, state, sourcePath);
      if (access !== 'read') {
        throw invalidAt(state.sourceFile, node.pos, `${name} access must be "read".`, sourcePath);
      }
      return {
        __kind: 'permission',
        resource: name === 'FileAccess' ? 'file' : 'folder',
        path: requireNonEmptyString(args[0], `${name} path`, node, state, sourcePath),
        access,
      };
    }
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
    case 'registerProfile': {
      argsRange(name, args, 1, 2, node, state, sourcePath);
      const options = args[1] === undefined ? {} : requireObject(args[1], 'registerProfile options', node, state, sourcePath);
      rejectUnknown(options, ['model', 'think', 'memory', 'history'], name, node, state, sourcePath);
      return {
        __kind: 'profile',
        profileName: requireString(args[0], 'profile name', node, state, sourcePath),
        ...(options.model !== undefined
          ? { modelId: requireString(options.model, 'model', node, state, sourcePath) }
          : {}),
        ...(options.think !== undefined
          ? { think: requireBoolean(options.think, 'think', node, state, sourcePath) }
          : {}),
        memory: options.memory === undefined ? false : requireBoolean(options.memory, 'memory', node, state, sourcePath),
        history: options.history === undefined ? false : requireBoolean(options.history, 'history', node, state, sourcePath),
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
        if (options[key] !== false) { throw invalidAt(state.sourceFile, node.pos, `useSkill.${key} must be false in v1.`, sourcePath); }
      }
      return {
        __kind: 'operation',
        model: requireTagged(args[0], 'model', node, state, sourcePath),
        skill: requireTagged(args[1], 'skill', node, state, sourcePath),
        parameters: requireObject(options.parameters, 'useSkill parameters', node, state, sourcePath),
        output: requireTagged(options.output, 'state', node, state, sourcePath),
      };
    }
    case 'useProfileSkill': {
      exactArgs(name, args, 3, node, state, sourcePath);
      const profile = requireTagged(args[0], 'profile', node, state, sourcePath);
      const skillName = typeof args[1] === 'string' ? args[1] : undefined;
      const skillState = skillName === undefined
        ? requireTagged(args[1], 'state', node, state, sourcePath)
        : undefined;
      if (skillName !== undefined && !SAFE_SKILL_NAME.test(skillName)) {
        throw invalidAt(state.sourceFile, node.pos, `Invalid profile skill name '${skillName}'.`, sourcePath);
      }
      const options = requireObject(args[2], 'useProfileSkill options', node, state, sourcePath);
      rejectUnknown(options, ['skills', 'input', 'attachments', 'stripSkillName', 'parameters', 'output', 'result', 'interactive'], name, node, state, sourcePath);
      if (skillName !== undefined && options.skills !== undefined) {
        throw invalidAt(state.sourceFile, node.pos, 'useProfileSkill.skills is only valid when the Skill is selected by State.', sourcePath);
      }
      if (skillState !== undefined && options.skills === undefined) {
        throw invalidAt(state.sourceFile, node.pos, 'A state-selected profile Skill requires a non-empty useProfileSkill.skills allowlist.', sourcePath);
      }
      const interactive = options.interactive === undefined
        ? undefined
        : requireBoolean(options.interactive, 'interactive', node, state, sourcePath);
      if (interactive && skillState !== undefined) {
        throw invalidAt(
          state.sourceFile,
          node.pos,
          'An interactive profile operation must use one fixed Agent Skill.',
          sourcePath,
        );
      }
      return {
        __kind: 'operation',
        profile,
        ...(skillName !== undefined ? { skillName } : { skillState }),
        ...(options.skills !== undefined ? { skillOptions: options.skills } : {}),
        ...(options.input !== undefined
          ? { input: requireTagged(options.input, 'state', node, state, sourcePath) }
          : {}),
        ...(options.attachments !== undefined
          ? { attachments: requireTagged(options.attachments, 'attachment_state', node, state, sourcePath) }
          : {}),
        ...(options.stripSkillName !== undefined
          ? { stripSkillName: requireBoolean(options.stripSkillName, 'stripSkillName', node, state, sourcePath) }
          : {}),
        parameters: options.parameters === undefined
          ? {}
          : requireObject(options.parameters, 'useProfileSkill parameters', node, state, sourcePath),
        output: requireTagged(options.output, 'state', node, state, sourcePath),
        result: requireTagged(options.result, 'text_result', node, state, sourcePath),
        ...(interactive !== undefined ? { interactive } : {}),
      };
    }
    case 'trigger': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const operation = requireTagged(args[0], 'operation', node, state, sourcePath);
      const options = requireObject(args[1], 'trigger options', node, state, sourcePath);
      rejectUnknown(options, ['onChange', 'debounce', 'concurrency'], name, node, state, sourcePath);
      const onChange = requireArray(options.onChange, 'trigger onChange', node, state, sourcePath)
        .map(value => requireNamedReference(value, 'state', node, state, sourcePath));
      if (onChange.length === 0) { throw invalidAt(state.sourceFile, node.pos, 'trigger.onChange cannot be empty.', sourcePath); }
      const debounce = options.debounce === undefined ? 0 : requireNonNegativeInteger(options.debounce, 'debounce', node, state, sourcePath);
      if (debounce > 60_000) { throw invalidAt(state.sourceFile, node.pos, 'trigger.debounce cannot exceed 60000 ms.', sourcePath); }
      const concurrency = options.concurrency === undefined
        ? 'latest'
        : requireString(options.concurrency, 'concurrency', node, state, sourcePath);
      if (concurrency !== 'latest') { throw invalidAt(state.sourceFile, node.pos, 'trigger.concurrency must be "latest" in v1.', sourcePath); }
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
      rejectUnknown(template, ['app', 'permissions', 'ui'], name, node, state, sourcePath);
      return {
        __kind: 'skillapp',
        app: requireObject(template.app, 'app metadata', node, state, sourcePath),
        permissions: template.permissions === undefined
          ? []
          : requireArray(template.permissions, 'defineSkillApp permissions', node, state, sourcePath),
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
      const allowed = name === 'Row' ? ['gap', 'responsive', 'align'] : name === 'Column' ? ['gap', 'align'] : [];
      rejectUnknown(options, allowed, name, node, state, sourcePath);
      return { __kind: 'component', component: name.toLowerCase(), children, options };
    }
    case 'Spacer':
      exactArgs(name, args, 0, node, state, sourcePath);
      return { __kind: 'component', component: 'spacer', options: {} };
    case 'Textarea': {
      argsRange(name, args, 2, 3, node, state, sourcePath);
      const options = args[2] === undefined ? {} : requireObject(args[2], 'Textarea options', node, state, sourcePath);
      rejectUnknown(options, ['showLabel', 'grow', 'editable', 'copyable', 'rows', 'autoGrow', 'placeholder'], name, node, state, sourcePath);
      return {
        __kind: 'component', component: 'textarea', label: requireNonEmptyString(args[0], 'Textarea label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath), options,
      };
    }
    case 'Markdown': {
      argsRange(name, args, 2, 3, node, state, sourcePath);
      const options = args[2] === undefined ? {} : requireObject(args[2], 'Markdown options', node, state, sourcePath);
      rejectUnknown(options, ['showLabel', 'grow', 'copyable', 'sourceToggle', 'placeholder'], name, node, state, sourcePath);
      return {
        __kind: 'component', component: 'markdown', label: requireNonEmptyString(args[0], 'Markdown label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath),
        options: {
          ...options,
          copyable: options.copyable === undefined ? true : requireBoolean(options.copyable, 'copyable', node, state, sourcePath),
          sourceToggle: options.sourceToggle === undefined ? true : requireBoolean(options.sourceToggle, 'sourceToggle', node, state, sourcePath),
        },
      };
    }
    case 'Download': {
      exactArgs(name, args, 3, node, state, sourcePath);
      const options = requireObject(args[2], 'Download options', node, state, sourcePath);
      rejectUnknown(options, ['filename', 'mediaType', 'description', 'showLabel', 'grow'], name, node, state, sourcePath);
      const filename = requireNonEmptyString(options.filename, 'Download filename', node, state, sourcePath);
      if (!SAFE_DOWNLOAD_FILENAME.test(filename) || filename === '.' || filename === '..') {
        throw invalidAt(state.sourceFile, node.pos, 'Download filename must be one safe file name without a path.', sourcePath);
      }
      const mediaType = options.mediaType === undefined
        ? 'text/plain;charset=utf-8'
        : requireNonEmptyString(options.mediaType, 'Download mediaType', node, state, sourcePath);
      if (!SAFE_DOWNLOAD_MEDIA_TYPE.test(mediaType)) {
        throw invalidAt(state.sourceFile, node.pos, `Invalid Download mediaType '${mediaType}'.`, sourcePath);
      }
      return {
        __kind: 'component', component: 'download', label: requireNonEmptyString(args[0], 'Download label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath),
        options: { ...options, filename, mediaType },
      };
    }
    case 'Select': {
      exactArgs(name, args, 3, node, state, sourcePath);
      const options = requireObject(args[2], 'Select options', node, state, sourcePath);
      rejectUnknown(options, ['options', 'showLabel', 'grow'], name, node, state, sourcePath);
      const choices = requireArray(options.options, 'Select options.options', node, state, sourcePath)
        .map(value => requireSelectOption(value, node, state, sourcePath));
      if (choices.length === 0) { throw invalidAt(state.sourceFile, node.pos, 'Select options cannot be empty.', sourcePath); }
      return {
        __kind: 'component', component: 'select', label: requireNonEmptyString(args[0], 'Select label', node, state, sourcePath),
        bind: requireTagged(args[1], 'state', node, state, sourcePath),
        options: { ...options, options: choices as unknown as Evaluated[] },
      };
    }
    case 'Attachments': {
      argsRange(name, args, 2, 3, node, state, sourcePath);
      const options = args[2] === undefined ? {} : requireObject(args[2], 'Attachments options', node, state, sourcePath);
      rejectUnknown(options, ['showLabel', 'grow'], name, node, state, sourcePath);
      return {
        __kind: 'component', component: 'attachments', label: requireNonEmptyString(args[0], 'Attachments label', node, state, sourcePath),
        bind: requireTagged(args[1], 'attachment_state', node, state, sourcePath), options,
      };
    }
    case 'Button': {
      exactArgs(name, args, 2, node, state, sourcePath);
      const options = requireObject(args[1], 'Button options', node, state, sourcePath);
      rejectUnknown(options, ['trigger', 'emphasis', 'alignToField'], name, node, state, sourcePath);
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
  if (depth > 4) { throw MarifoldError.appInvalid('SkillApp layout depth cannot exceed four.', sourcePath); }
  const component = requireString(value.component, 'component name', state.sourceFile, state, sourcePath) as SkillAppLayoutItem['component'];
  const options = requireObject(value.options ?? {}, `${component} options`, state.sourceFile, state, sourcePath);
  const item: SkillAppLayoutItem = { component };
  if (value.children) {
    item.children = requireArray(value.children, `${component} children`, state.sourceFile, state, sourcePath)
      .map(child => normalizeComponent(requireTagged(child, 'component', state.sourceFile, state, sourcePath), state, sourcePath, depth + 1));
  }
  if (value.label !== undefined) { item.label = requireString(value.label, `${component} label`, state.sourceFile, state, sourcePath); }
  if (value.bind !== undefined) { item.bind = requireNamedReference(
    value.bind,
    component === 'attachments' ? 'attachment_state' : 'state',
    state.sourceFile,
    state,
    sourcePath,
  ); }
  if (value.operation !== undefined) { item.trigger = requireName(requireTagged(value.operation, 'operation', state.sourceFile, state, sourcePath), 'operation', state.sourceFile, state, sourcePath); }
  copyBoolean(options, 'showLabel', item, state, sourcePath);
  copyBoolean(options, 'grow', item, state, sourcePath);
  copyBoolean(options, 'editable', item, state, sourcePath);
  copyBoolean(options, 'copyable', item, state, sourcePath);
  copyBoolean(options, 'autoGrow', item, state, sourcePath);
  copyBoolean(options, 'sourceToggle', item, state, sourcePath);
  copyBoolean(options, 'alignToField', item, state, sourcePath);
  if (options.rows !== undefined) {
    item.rows = requireNonNegativeInteger(options.rows, 'rows', state.sourceFile, state, sourcePath);
    if (item.rows < 1 || item.rows > 40) {
      throw MarifoldError.appInvalid('Textarea rows must be between 1 and 40.', sourcePath);
    }
  }
  copyString(options, 'placeholder', item, state, sourcePath);
  copyString(options, 'filename', item, state, sourcePath);
  copyString(options, 'mediaType', item, state, sourcePath);
  copyString(options, 'description', item, state, sourcePath);
  copyString(options, 'gap', item, state, sourcePath);
  copyString(options, 'responsive', item, state, sourcePath);
  copyString(options, 'align', item, state, sourcePath);
  copyString(options, 'emphasis', item, state, sourcePath);
  if (options.options !== undefined) {
    item.options = requireArray(options.options, 'Select options', state.sourceFile, state, sourcePath)
      .map(choice => requireSelectOption(choice, state.sourceFile, state, sourcePath));
  }
  if (item.component === 'textarea' && item.editable === undefined) { item.editable = true; }
  if (item.component === 'button' && item.emphasis === undefined) { item.emphasis = 'primary'; }
  if (item.gap !== undefined && !['none', 'small', 'medium', 'large'].includes(item.gap)) {
    throw MarifoldError.appInvalid(`Invalid layout gap '${item.gap}'.`, sourcePath);
  }
  if (item.responsive !== undefined && item.responsive !== 'stack') {
    throw MarifoldError.appInvalid(`Invalid responsive behavior '${item.responsive}'.`, sourcePath);
  }
  const alignments = item.component === 'column' ? ['start', 'center', 'end'] : ['start', 'center', 'end', 'between'];
  if (item.align !== undefined && !alignments.includes(item.align)) {
    throw MarifoldError.appInvalid(`Invalid ${item.component} alignment '${item.align}'.`, sourcePath);
  }
  if (item.emphasis !== undefined && !['primary', 'secondary'].includes(item.emphasis)) {
    throw MarifoldError.appInvalid(`Invalid button emphasis '${item.emphasis}'.`, sourcePath);
  }
  if (item.options && new Set(item.options.map(selectOptionValue)).size !== item.options.length) {
    throw MarifoldError.appInvalid('Select options must be unique.', sourcePath);
  }
  return item;
}
