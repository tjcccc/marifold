import type { UsageInfo } from '@priest-ai/core';

export const SKILL_APP_SCHEMA = 'marifold.skillapp.v1';

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

export interface SkillAppModelDefinition {
  name: string;
  provider: string;
  model: string;
  think: boolean;
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
  memory: false;
  history: false;
  profileContext: false;
}

export interface SkillAppOperationDefinition {
  name: string;
  model: string;
  skill: string;
  parameters: Record<string, string>;
  /** State names derived from required, default-less SKILL.md variables. */
  requiredInputs: string[];
  output: string;
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
  | 'select'
  | 'button';

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
  placeholder?: string;
  emphasis?: SkillAppButtonEmphasis;
  options?: string[];
}

/** Renderer-neutral output of the statically parsed `skillapp.ts` template. */
export interface SkillAppDefinition {
  schema: typeof SKILL_APP_SCHEMA;
  app: SkillAppInfo;
  states: SkillAppStateDefinition[];
  models: SkillAppModelDefinition[];
  skills: SkillAppSkillDefinition[];
  operations: SkillAppOperationDefinition[];
  triggers: SkillAppTriggerDefinition[];
  layout: SkillAppLayoutItem[];
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
}

export interface SkillAppErrorResult {
  status: 'error';
  error: { code: string; message: string };
}

export type SkillAppResult = SkillAppSuccessResult | SkillAppErrorResult;

export interface SkillAppInstanceSnapshot {
  id: string;
  appName: string;
  state: Record<string, SkillAppStateValue>;
}

export type SkillAppMutationStatus = 'idle' | 'completed' | 'superseded';
export type SkillAppMutationReason = 'missing_required_input';

export interface SkillAppMutationResult {
  status: SkillAppMutationStatus;
  reason?: SkillAppMutationReason;
  operation?: string;
  instance: SkillAppInstanceSnapshot;
  result?: SkillAppResult;
}
