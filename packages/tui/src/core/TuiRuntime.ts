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
} & { createAgentRunner(profile?: string): Pick<AgentRunner, 'run'>; refresh?: () => Promise<void> };
