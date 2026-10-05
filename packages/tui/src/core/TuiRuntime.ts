import type { AgentRunner, MarifoldRuntime } from '@marifold/core';
type Reads =
  | 'listProfiles'
  | 'listSkills'
  | 'getProfile'
  | 'getSkill'
  | 'resolveSettings'
  | 'resolveAgentConfigForProfile'
  | 'stream';
type AsyncMethods =
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
  releaseSession?: (id: string) => void | Promise<void>;
  createAgentRunner(profile?: string): Pick<AgentRunner, 'run'>;
  refresh?: () => Promise<void>;
};
