import type { UsageInfo } from '@priest-ai/core';
import type { ApprovalRequest } from '../agent/ApprovalPolicy';
import type { UserInputRequest } from '../agent/UserInput';

export const SKILL_APP_SCHEMA = 'marifold.skillapp.v1';
export const SKILL_APP_PROFILE_SCHEMA = 'marifold.skillapp.v2';

export type SkillAppSchema =
  | typeof SKILL_APP_SCHEMA
  | typeof SKILL_APP_PROFILE_SCHEMA;

export type SkillAppStateValue = string;
export type SkillAppConcurrency = 'latest';
export type SkillAppButtonEmphasis = 'primary' | 'secondary';
export type SkillAppLayoutGap = 'none' | 'small' | 'medium' | 'large';
export type SkillAppResponsiveBehavior = 'stack';

export interface SkillAppInfo {
  name: string;
  title: string;
  version?: string;
  description?: string;
}

export interface SkillAppStateDefinition {
  name: string;
  initial: SkillAppStateValue;
}

export interface SkillAppAttachmentStateDefinition {
  name: string;
}

export type SkillAppPermissionAccess = 'read';
export type SkillAppPermissionKind = 'file' | 'folder';

/** Server-only host capability compiled from a static SkillApp declaration.
 * Service responses remove these entries before definitions cross the wire. */
export interface SkillAppPermissionDefinition {
  kind: SkillAppPermissionKind;
  path: string;
  access: SkillAppPermissionAccess;
}

export interface SkillAppModelDefinition {
  name: string;
  provider: string;
  model: string;
  think: boolean;
}

/** A profile reference declared by a v2 template. Model/thinking overrides
 * are local to the App and never mutate the underlying profile settings. */
export interface SkillAppProfileDefinition {
  /** Template-local const name used by operations. */
  name: string;
  /** Stable profile name resolved from the configured profiles directory. */
  profile: string;
  provider?: string;
  model?: string;
  think?: boolean;
  /** Read-only profile memory for this operation. Agent runs never write it. */
  memory: boolean;
  /** Ephemeral history shared only inside one App instance/profile reference. */
  history: boolean;
}

export interface SkillAppTextResultDefinition {
  kind: 'text';
  trim: boolean;
}

export interface SkillAppSkillDefinition {
  name: string;
  result: SkillAppTextResultDefinition;
}

export interface SkillAppExecution {
  memory: boolean;
  history: boolean;
  profileContext: boolean;
}

export interface SkillAppOperationDefinition {
  name: string;
  /** v1 app-local operation model reference. */
  model?: string;
  /** v2 profile reference. Mutually exclusive with `model`. */
  profile?: string;
  /** Fixed Skill name. Present on every v1 operation and fixed v2 operations. */
  skill?: string;
  /** State holding a selected v2 Skill name. */
  skillState?: string;
  /** Static allowlist for a state-selected v2 Skill. */
  skillOptions?: string[];
  /** Remove a pasted leading allowed Skill invocation from the ordinary input. */
  stripSkillName?: boolean;
  /** Optional ordinary user prompt binding for Skills without variables. */
  input?: string;
  /** Optional attachment-state binding staged read-only for this operation. */
  attachments?: string;
  parameters: Record<string, string>;
  /** State names derived from required, default-less SKILL.md variables. */
  requiredInputs: string[];
  output: string;
  /** v2 profile Skills declare their result adapter on the operation. */
  result?: SkillAppTextResultDefinition;
  /** Run this profile Agent Skill through the resumable interaction lifecycle. */
  interactive?: boolean;
  execution: SkillAppExecution;
}

export interface SkillAppTriggerDefinition {
  operation: string;
  onChange: string[];
  debounce: number;
  concurrency: SkillAppConcurrency;
}

export type SkillAppComponent =
  | 'app'
  | 'row'
  | 'column'
  | 'spacer'
  | 'textarea'
  | 'markdown'
  | 'download'
  | 'select'
  | 'attachments'
  | 'button';

export interface SkillAppSelectOption {
  label: string;
  value: string;
}

export interface SkillAppLayoutItem {
  component: SkillAppComponent;
  children?: SkillAppLayoutItem[];
  bind?: string;
  label?: string;
  trigger?: string;
  showLabel?: boolean;
  gap?: SkillAppLayoutGap;
  responsive?: SkillAppResponsiveBehavior;
  grow?: boolean;
  editable?: boolean;
  copyable?: boolean;
  rows?: number;
  autoGrow?: boolean;
  sourceToggle?: boolean;
  alignToField?: boolean;
  placeholder?: string;
  filename?: string;
  mediaType?: string;
  description?: string;
  emphasis?: SkillAppButtonEmphasis;
  options?: Array<string | SkillAppSelectOption>;
}

/** Renderer-neutral output of the statically parsed `skillapp.ts` template. */
export interface SkillAppDefinition {
  schema: SkillAppSchema;
  app: SkillAppInfo;
  states: SkillAppStateDefinition[];
  attachmentStates?: SkillAppAttachmentStateDefinition[];
  permissions?: SkillAppPermissionDefinition[];
  models: SkillAppModelDefinition[];
  /** Present in normalized definitions; optional for source compatibility with
   * renderer fixtures authored before the v2 profile extension. */
  profiles?: SkillAppProfileDefinition[];
  skills: SkillAppSkillDefinition[];
  operations: SkillAppOperationDefinition[];
  triggers: SkillAppTriggerDefinition[];
  layout: SkillAppLayoutItem[];
}

export interface SkillAppHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SkillAppResultMeta {
  engine: string;
  model: string;
  durationMs: number;
  usage?: UsageInfo;
}

export interface SkillAppSuccessResult {
  status: 'ok';
  data: { text: string };
  meta: SkillAppResultMeta;
  effects?: SkillAppEffect[];
}

export interface SkillAppErrorResult {
  status: 'error';
  error: { code: string; message: string };
}

export type SkillAppResult = SkillAppSuccessResult | SkillAppErrorResult;

export interface SkillAppInstalledEffect {
  kind: 'app_installed';
  appName: string;
  title: string;
  action: 'created' | 'updated';
  files: string[];
}

export type SkillAppEffect = SkillAppInstalledEffect;

export type SkillAppExecutionPhase =
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Service-owned lifecycle for one exclusive interactive operation. Template
 * authors never declare or bind this state; every renderer applies it. */
export interface SkillAppExecutionSnapshot {
  id: string;
  operation: string;
  phase: SkillAppExecutionPhase;
  startedAt: string;
  finishedAt?: string;
  cancellable: boolean;
  userInput?: UserInputRequest;
  approval?: ApprovalRequest;
  /** Persistent effects already committed before the Agent finishes its final
   * explanation. Cancellation cannot roll these back. */
  committedEffects?: SkillAppEffect[];
  result?: SkillAppResult;
}

export interface SkillAppInstanceSnapshot {
  id: string;
  appName: string;
  state: Record<string, SkillAppStateValue>;
  /** Output state names whose displayed value was produced from an older set
   * of inputs. Renderers preserve the value and identify it as stale. */
  staleOutputs?: string[];
  attachments?: Record<string, SkillAppAttachmentSummary[]>;
  execution?: SkillAppExecutionSnapshot;
}

export interface SkillAppAttachmentSummary {
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'file';
}

/** Base64-only service input. Host paths never cross the SkillApp API. */
export interface SkillAppAttachmentInput extends SkillAppAttachmentSummary {
  data: string;
  inspectionText?: string;
}

export type SkillAppMutationStatus = 'idle' | 'running' | 'completed' | 'superseded';
export type SkillAppMutationReason = 'missing_required_input';

export interface SkillAppMutationResult {
  status: SkillAppMutationStatus;
  reason?: SkillAppMutationReason;
  operation?: string;
  instance: SkillAppInstanceSnapshot;
  result?: SkillAppResult;
}
