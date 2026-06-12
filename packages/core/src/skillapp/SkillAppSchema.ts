export const SKILLAPP_SCHEMA = 'marifold.skillapp.v0';

export type SkillAppVariableType = 'string' | 'number' | 'boolean' | 'enum';
export type SkillAppVariableRole = 'input' | 'output' | 'state';
export type SkillAppComponent =
  | 'text'
  | 'text_input'
  | 'textarea'
  | 'select'
  | 'preview'
  | 'tabs'
  | 'file_picker'
  | 'button'
  | 'download_button';
export type SkillAppActionKind = 'model' | 'profile' | 'tool';
export type SkillAppFilesPermission = 'none' | 'read' | 'write';

/** Built-in tools a SkillApp action may reference. */
export const SKILLAPP_KNOWN_TOOLS = ['read_file', 'write_file', 'shell_exec', 'web_search', 'ask_profile'] as const;

export interface SkillAppInfo {
  name: string;
  title: string;
  description?: string;
}

export interface SkillAppVariable {
  name: string;
  type: SkillAppVariableType;
  role: SkillAppVariableRole;
  label?: string;
  default?: string | number | boolean;
  options?: string[];
}

export interface SkillAppLayoutItem {
  component: SkillAppComponent;
  bind?: string;
  label?: string;
  action?: string;
  content?: string;
  format?: string;
  tabs?: SkillAppLayoutItem[][];
}

export interface SkillAppAction {
  name: string;
  kind: SkillAppActionKind;
  profile?: string;
  tool?: string;
  prompt?: string;
  input?: Record<string, string | number | boolean>;
  output: string;
}

export interface SkillAppPermissions {
  providerCalls: boolean;
  files: SkillAppFilesPermission;
  shell: boolean;
  network: boolean;
  export: boolean;
}

export const DEFAULT_SKILLAPP_PERMISSIONS: SkillAppPermissions = {
  providerCalls: true,
  files: 'none',
  shell: false,
  network: false,
  export: true,
};

export interface SkillAppDefinition {
  schema: typeof SKILLAPP_SCHEMA;
  app: SkillAppInfo;
  variables: SkillAppVariable[];
  layout: SkillAppLayoutItem[];
  actions: SkillAppAction[];
  permissions: SkillAppPermissions;
}
