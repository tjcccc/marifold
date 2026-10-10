import type { AgentRunner, MarifoldRuntime } from '@marifold/core';
type Reads =
  | 'listProfiles'
  | 'listSkills'
  | 'getProfile'
  | 'getSkill'
  | 'resolveSettings'
  | 'resolveAgentConfigForProfile';
type AsyncMethods =
  | 'ask'
  | 'listSessions'
  | 'getSession'
  | 'getSessionAttachment'
  | 'setProfileAgentApproval'
  | 'addProfileTrustedFolder'
  | 'migrateProfileInstructions'
  | 'installSkillFromText'
  | 'installSkillFromFile'
  | 'rememberMemory'
  | 'forgetMemories'
  | 'deleteMemories'
  | 'setProfileMaxContextTokens'
  | 'compactSession'
  | 'removeSkill';
export type TuiRuntime = Pick<MarifoldRuntime, Reads> & {
  [K in AsyncMethods]: (
    ...args: Parameters<MarifoldRuntime[K]>
  ) => ReturnType<MarifoldRuntime[K]> | Promise<Awaited<ReturnType<MarifoldRuntime[K]>>>;
} & {
  acquireSession?: (id: string) => void | Promise<void>;
  /** Runs execute in the service: leaving their event stream does not stop them. */
  remote?: boolean;
  /** Move a session held by another of the owner's devices or pages here. */
  takeOverSession?: (id: string) => void | Promise<void>;
  releaseSession?: (id: string) => void | Promise<void>;
  createAgentRunner(profile?: string): Pick<AgentRunner, 'run'>;
  refresh?: () => Promise<void>;
};
