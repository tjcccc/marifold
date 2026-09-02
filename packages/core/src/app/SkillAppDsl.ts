import type {
  SkillAppButtonEmphasis,
  SkillAppConcurrency,
  SkillAppInfo,
  SkillAppLayoutGap,
  SkillAppResponsiveBehavior,
  SkillAppSelectOption,
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

export interface AttachmentStateReference {
  readonly kind: 'attachment_state';
}

export interface PermissionReference {
  readonly kind: 'permission';
  readonly resource: 'file' | 'folder';
  readonly path: string;
  readonly access: 'read';
}

export interface ModelReference {
  readonly kind: 'model';
  readonly id: string;
  readonly options: { think?: boolean };
}

export interface ProfileReference {
  readonly kind: 'profile';
  readonly profile: string;
  readonly options: {
    model?: string;
    think?: boolean;
    memory: boolean;
    history: boolean;
  };
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
  readonly model?: ModelReference;
  readonly profile?: ProfileReference;
  readonly skill: SkillReference | string | StateReference;
  readonly skillOptions?: readonly (string | SkillAppSelectOption)[];
  readonly stripSkillName?: boolean;
  readonly input?: StateReference;
  readonly attachments?: AttachmentStateReference;
  readonly parameters: Record<string, StateReference>;
  readonly output: StateReference;
  readonly result?: TextResultReference;
  readonly interactive?: boolean;
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
  permissions?: readonly PermissionReference[];
  ui: ComponentReference;
}

export function State<T extends string>(initial: T): StateReference<T> {
  return { kind: 'state', initial };
}

export function AttachmentState(): AttachmentStateReference {
  return { kind: 'attachment_state' };
}

export function FileAccess(path: string, options: { access: 'read' }): PermissionReference {
  return { kind: 'permission', resource: 'file', path, access: options.access };
}

export function FolderAccess(path: string, options: { access: 'read' }): PermissionReference {
  return { kind: 'permission', resource: 'folder', path, access: options.access };
}

export function registerModel(id: string, options: { think?: boolean } = {}): ModelReference {
  return { kind: 'model', id, options };
}

export function registerProfile(
  profile: string,
  options: {
    model?: string;
    think?: boolean;
    memory?: boolean;
    history?: boolean;
  } = {},
): ProfileReference {
  return {
    kind: 'profile',
    profile,
    options: {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.think !== undefined ? { think: options.think } : {}),
      memory: options.memory ?? false,
      history: options.history ?? false,
    },
  };
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

export function useProfileSkill(
  profile: ProfileReference,
  skill: string | StateReference,
  options: {
    /** Required static allowlist when `skill` is a State reference. */
    skills?: readonly (string | SkillAppSelectOption)[];
    input?: StateReference;
    attachments?: AttachmentStateReference;
    stripSkillName?: boolean;
    parameters?: Record<string, StateReference>;
    output: StateReference;
    result: TextResultReference;
    /** Use the renderer-neutral interactive Agent lifecycle for this operation. */
    interactive?: boolean;
  },
): OperationReference {
  return {
    kind: 'operation',
    profile,
    skill,
    ...(options.skills ? { skillOptions: options.skills } : {}),
    ...(options.input ? { input: options.input } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.stripSkillName !== undefined ? { stripSkillName: options.stripSkillName } : {}),
    parameters: options.parameters ?? {},
    output: options.output,
    result: options.result,
    ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
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
    rows?: number;
    autoGrow?: boolean;
    placeholder?: string;
  } = {},
): ComponentReference {
  return component('textarea', undefined, { label, state }, options);
}

export function Markdown(
  label: string,
  state: StateReference,
  options: {
    showLabel?: boolean;
    grow?: boolean;
    copyable?: boolean;
    sourceToggle?: boolean;
    placeholder?: string;
  } = {},
): ComponentReference {
  return component('markdown', undefined, { label, state }, options);
}

export function Download(
  label: string,
  state: StateReference,
  options: {
    filename: string;
    mediaType?: string;
    description?: string;
    showLabel?: boolean;
    grow?: boolean;
  },
): ComponentReference {
  return component('download', undefined, { label, state }, options);
}

export function Select(
  label: string,
  state: StateReference,
  options: {
    options: readonly (string | SkillAppSelectOption)[];
    showLabel?: boolean;
    grow?: boolean;
  },
): ComponentReference {
  return component('select', undefined, { label, state }, options);
}

export function Attachments(
  label: string,
  state: AttachmentStateReference,
  options: {
    showLabel?: boolean;
    grow?: boolean;
  } = {},
): ComponentReference {
  return component('attachments', undefined, { label, state }, options);
}

export function Button(
  label: string,
  options: {
    trigger: OperationReference;
    emphasis?: SkillAppButtonEmphasis;
    alignToField?: boolean;
  },
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
