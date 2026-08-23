import type {
  SkillAppButtonEmphasis,
  SkillAppConcurrency,
  SkillAppInfo,
  SkillAppLayoutGap,
  SkillAppResponsiveBehavior,
} from './SkillAppSchema';

/**
 * Authoring types for `skillapp.ts`. The service statically parses templates;
 * it never imports or executes them. These builders exist for editor checking
 * and completion and intentionally contain no general-purpose runtime.
 */

export interface StateReference<T extends string = string> {
  readonly kind: 'state';
  readonly initial: T;
}

export interface ModelReference {
  readonly kind: 'model';
  readonly id: string;
  readonly options: { think?: boolean };
}

export interface TextResultReference {
  readonly kind: 'text_result';
  readonly trim: boolean;
}

export interface SkillReference {
  readonly kind: 'skill';
  readonly name: string;
  readonly result: TextResultReference;
}

export interface OperationReference {
  readonly kind: 'operation';
  readonly model: ModelReference;
  readonly skill: SkillReference;
  readonly parameters: Record<string, StateReference>;
  readonly output: StateReference;
}

export interface ComponentReference {
  readonly kind: 'component';
  readonly component: string;
  readonly children?: readonly ComponentReference[];
  readonly value?: unknown;
  readonly options?: Record<string, unknown>;
}

export interface SkillAppTemplate {
  app: SkillAppInfo;
  ui: ComponentReference;
}

export function State<T extends string>(initial: T): StateReference<T> {
  return { kind: 'state', initial };
}

export function registerModel(id: string, options: { think?: boolean } = {}): ModelReference {
  return { kind: 'model', id, options };
}

export function TextResult(options: { trim?: boolean } = {}): TextResultReference {
  return { kind: 'text_result', trim: options.trim ?? false };
}

export function registerSkill(
  name: string,
  options: { result: TextResultReference },
): SkillReference {
  return { kind: 'skill', name, result: options.result };
}

export function useSkill(
  model: ModelReference,
  skill: SkillReference,
  options: {
    parameters: Record<string, StateReference>;
    output: StateReference;
    memory: false;
    history: false;
    profileContext: false;
  },
): OperationReference {
  return {
    kind: 'operation',
    model,
    skill,
    parameters: options.parameters,
    output: options.output,
  };
}

export function trigger(
  _operation: OperationReference,
  _options: {
    onChange: readonly StateReference[];
    debounce?: number;
    concurrency?: SkillAppConcurrency;
  },
): void {}

export function defineSkillApp(template: SkillAppTemplate): SkillAppTemplate {
  return template;
}

export function App(children: readonly ComponentReference[]): ComponentReference {
  return component('app', children);
}

export function Row(
  children: readonly ComponentReference[],
  options: { gap?: SkillAppLayoutGap; responsive?: SkillAppResponsiveBehavior } = {},
): ComponentReference {
  return component('row', children, undefined, options);
}

export function Column(
  children: readonly ComponentReference[],
  options: { gap?: SkillAppLayoutGap } = {},
): ComponentReference {
  return component('column', children, undefined, options);
}

export function Spacer(): ComponentReference {
  return component('spacer');
}

export function Textarea(
  label: string,
  state: StateReference,
  options: {
    showLabel?: boolean;
    grow?: boolean;
    editable?: boolean;
    copyable?: boolean;
    placeholder?: string;
  } = {},
): ComponentReference {
  return component('textarea', undefined, { label, state }, options);
}

export function Select(
  label: string,
  state: StateReference,
  options: { options: readonly string[]; showLabel?: boolean; grow?: boolean },
): ComponentReference {
  return component('select', undefined, { label, state }, options);
}

export function Button(
  label: string,
  options: { trigger: OperationReference; emphasis?: SkillAppButtonEmphasis },
): ComponentReference {
  return component('button', undefined, { label }, options);
}

function component(
  name: string,
  children?: readonly ComponentReference[],
  value?: unknown,
  options?: Record<string, unknown>,
): ComponentReference {
  return {
    kind: 'component',
    component: name,
    ...(children ? { children } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  };
}
