import * as ts from 'typescript-compiler';
import { MarifoldError } from '../errors/MarifoldError';
import type { SkillAppAttachmentStateDefinition, SkillAppLayoutItem, SkillAppModelDefinition, SkillAppOperationDefinition, SkillAppProfileDefinition, SkillAppSelectOption, SkillAppSkillDefinition, SkillAppStateDefinition, SkillAppTriggerDefinition } from './SkillAppSchema';

// Compilation state and the AST/value checks the SkillApp compiler applies to restricted TypeScript templates.

export const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type Primitive = string | number | boolean | null;

export type Evaluated = Primitive | Evaluated[] | { [key: string]: Evaluated } | TaggedValue;

export interface TaggedValue {
  __kind: string;
  name?: string;
  [key: string]: Evaluated | string | undefined;
}

export interface CompilationState {
  sourceFile: ts.SourceFile;
  imports: Map<string, string>;
  values: Map<string, Evaluated>;
  states: SkillAppStateDefinition[];
  attachmentStates: SkillAppAttachmentStateDefinition[];
  models: SkillAppModelDefinition[];
  profiles: SkillAppProfileDefinition[];
  skills: SkillAppSkillDefinition[];
  operations: SkillAppOperationDefinition[];
  triggers: SkillAppTriggerDefinition[];
  template?: { app: Record<string, Evaluated>; permissions: TaggedValue[]; ui: TaggedValue };
}

export function flatten(items: SkillAppLayoutItem[]): SkillAppLayoutItem[] {
  return items.flatMap(item => [item, ...flatten(item.children ?? [])]);
}

export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

export function builderName(expression: ts.LeftHandSideExpression, state: CompilationState): string | undefined {
  return ts.isIdentifier(expression) ? state.imports.get(expression.text) : undefined;
}

export function propertyName(name: ts.PropertyName, state: CompilationState, sourcePath: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) { return name.text; }
  throw invalidAt(state.sourceFile, name.pos, 'Computed property names are not allowed.', sourcePath);
}

export function isTagged(value: Evaluated | undefined): value is TaggedValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__kind' in value;
}

export function requireTagged(value: Evaluated | undefined, kind: string, node: ts.Node, state: CompilationState, sourcePath: string): TaggedValue {
  if (isTagged(value) && value.__kind === kind) { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${kind} reference.`, sourcePath);
}

export function requireObject(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): Record<string, Evaluated> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isTagged(value)) { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be an object.`, sourcePath);
}

export function requireArray(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): Evaluated[] {
  if (Array.isArray(value)) { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be an array.`, sourcePath);
}

export function requireSelectOption(
  value: Evaluated,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): string | SkillAppSelectOption {
  if (typeof value === 'string') {
    return requireNonEmptyString(value, 'Select option', node, state, sourcePath);
  }
  const option = requireObject(value, 'Select option', node, state, sourcePath);
  rejectUnknown(option, ['label', 'value'], 'Select option', node, state, sourcePath);
  return {
    label: requireNonEmptyString(option.label, 'Select option label', node, state, sourcePath),
    value: requireNonEmptyString(option.value, 'Select option value', node, state, sourcePath),
  };
}

export function requireSkillOptionValues(
  value: Evaluated,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): string[] {
  const skills = requireArray(value, 'useProfileSkill skills', node, state, sourcePath)
    .map(option => selectOptionValue(requireSelectOption(option, node, state, sourcePath)));
  if (skills.length === 0) {
    throw invalidAt(state.sourceFile, node.pos, 'useProfileSkill.skills cannot be empty.', sourcePath);
  }
  for (const skill of skills) {
    if (!SAFE_SKILL_NAME.test(skill)) {
      throw invalidAt(state.sourceFile, node.pos, `Invalid profile skill name '${skill}'.`, sourcePath);
    }
  }
  if (new Set(skills).size !== skills.length) {
    throw invalidAt(state.sourceFile, node.pos, 'useProfileSkill.skills must be unique.', sourcePath);
  }
  return skills;
}

export function selectOptionValue(option: string | SkillAppSelectOption): string {
  return typeof option === 'string' ? option : option.value;
}

export function requireString(value: Evaluated | string | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  if (typeof value === 'string') { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a string.`, sourcePath);
}

export function requireNonEmptyString(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  const text = requireString(value, label, node, state, sourcePath).trim();
  if (!text) { throw invalidAt(state.sourceFile, node.pos, `${label} cannot be empty.`, sourcePath); }
  return text;
}

export function requireBoolean(value: Evaluated | string | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): boolean {
  if (typeof value === 'boolean') { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a boolean.`, sourcePath);
}

export function requireNonNegativeInteger(value: Evaluated | undefined, label: string, node: ts.Node, state: CompilationState, sourcePath: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) { return value; }
  throw invalidAt(state.sourceFile, node.pos, `Expected ${label} to be a non-negative integer.`, sourcePath);
}

export function requireName(value: TaggedValue, kind: string, node: ts.Node, state: CompilationState, sourcePath: string): string {
  if (value.name) { return value.name; }
  throw invalidAt(state.sourceFile, node.pos, `The ${kind} reference must first be assigned to a const.`, sourcePath);
}

export function requireNamedReference(
  value: Evaluated | string | undefined,
  kind: string,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
  skillUsesRegisteredName = false,
): string {
  const tagged = requireTagged(value as Evaluated, kind, node, state, sourcePath);
  if (skillUsesRegisteredName) { return requireString(tagged.skillName, 'registered skill name', node, state, sourcePath); }
  return requireName(tagged, kind, node, state, sourcePath);
}

export function exactArgs(name: string, args: Evaluated[], count: number, node: ts.Node, state: CompilationState, sourcePath: string): void {
  argsRange(name, args, count, count, node, state, sourcePath);
}

export function argsRange(name: string, args: Evaluated[], min: number, max: number, node: ts.Node, state: CompilationState, sourcePath: string): void {
  if (args.length < min || args.length > max) {
    throw invalidAt(state.sourceFile, node.pos, `${name} expects ${min === max ? String(min) : `${min}-${max}`} argument(s).`, sourcePath);
  }
}

export function rejectUnknown(
  object: Record<string, Evaluated>,
  allowed: string[],
  label: string,
  node: ts.Node,
  state: CompilationState,
  sourcePath: string,
): void {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length > 0) { throw invalidAt(state.sourceFile, node.pos, `${label} does not support: ${unknown.join(', ')}.`, sourcePath); }
}

export function copyBoolean(
  source: Record<string, Evaluated>,
  key: 'showLabel' | 'grow' | 'editable' | 'copyable' | 'autoGrow' | 'sourceToggle' | 'alignToField',
  target: SkillAppLayoutItem,
  state: CompilationState,
  sourcePath: string,
): void {
  if (source[key] !== undefined) { target[key] = requireBoolean(source[key], key, state.sourceFile, state, sourcePath); }
}

export function copyString(
  source: Record<string, Evaluated>,
  key: 'placeholder' | 'filename' | 'mediaType' | 'description' | 'gap' | 'responsive' | 'emphasis',
  target: SkillAppLayoutItem,
  state: CompilationState,
  sourcePath: string,
): void {
  if (source[key] !== undefined) { (target as unknown as Record<string, unknown>)[key] = requireString(source[key], key, state.sourceFile, state, sourcePath); }
}

export function invalidAt(sourceFile: ts.SourceFile, position: number | undefined, message: string, sourcePath: string): MarifoldError {
  const location = sourceFile.getLineAndCharacterOfPosition(Math.max(0, position ?? 0));
  return MarifoldError.appInvalid(`${message} (${location.line + 1}:${location.character + 1})`, sourcePath);
}
