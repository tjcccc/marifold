export const APP_SCHEMA = 'marifold.app.v0';

export type AppVariableType = 'string' | 'number' | 'boolean' | 'enum';
export type AppVariableRole = 'input' | 'output' | 'state';
export type AppComponent =
  | 'row'
  | 'column'
  | 'spacer'
  | 'text'
  | 'text_input'
  | 'textarea'
  | 'select'
  | 'preview'
  | 'tabs'
  | 'file_picker'
  | 'button'
  | 'download_button';
export type AppActionKind = 'skill';
export type AppFilesPermission = 'none' | 'read' | 'write';
export type AppLayoutGap = 'none' | 'small' | 'medium' | 'large';
export type AppResponsiveBehavior = 'stack';
export type AppVariableValue = string | number | boolean;

export interface AppInfo {
  name: string;
  title: string;
  version?: string;
  description?: string;
}

/** A named profile available to App actions. Actors make every profile
 * dependency explicit and let one App coordinate multiple specialized
 * profiles without inheriting whichever profile is open in Agent. */
export interface AppActor {
  name: string;
  profile: string;
  label?: string;
}

export interface AppVariable {
  name: string;
  type: AppVariableType;
  role: AppVariableRole;
  label?: string;
  required?: boolean;
  default?: AppVariableValue;
  options?: string[];
}

export interface AppLayoutItem {
  component: AppComponent;
  bind?: string;
  label?: string;
  action?: string;
  content?: string;
  format?: string;
  showLabel?: boolean;
  gap?: AppLayoutGap;
  responsive?: AppResponsiveBehavior;
  grow?: boolean;
  children?: AppLayoutItem[];
  tabs?: AppLayoutItem[][];
}

/** v0 executes only server-owned profile Skills. Other effectful action kinds
 * remain out of schema until Apps have an approval-aware run contract. */
export interface AppAction {
  name: string;
  kind: AppActionKind;
  actor: string;
  skill: string;
  arguments: Record<string, AppVariableValue>;
  output: string;
}

export interface AppPermissions {
  providerCalls: boolean;
  files: AppFilesPermission;
  shell: boolean;
  network: boolean;
  export: boolean;
}

/** Context/cost policy for focused App runs. App actions never replay or write
 * Agent sessions; App-specific run history can be introduced independently. */
export interface AppExecution {
  think: boolean;
  memory: boolean;
  profileContext: boolean;
}

export const DEFAULT_APP_PERMISSIONS: AppPermissions = {
  providerCalls: true,
  files: 'none',
  shell: false,
  network: false,
  export: true,
};

export const DEFAULT_APP_EXECUTION: AppExecution = {
  think: false,
  memory: false,
  profileContext: false,
};

export interface AppDefinition {
  schema: typeof APP_SCHEMA;
  app: AppInfo;
  actors: AppActor[];
  variables: AppVariable[];
  layout: AppLayoutItem[];
  actions: AppAction[];
  execution: AppExecution;
  permissions: AppPermissions;
}
