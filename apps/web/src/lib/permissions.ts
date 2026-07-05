import type { ApprovalMode, MarifoldAgentConfig, PartialAgentConfig, ToolKind } from '../api/types';

/** Mirrors core's DEFAULT_AGENT_CONFIG approval defaults. */
const DEFAULT_APPROVAL: Record<ToolKind, ApprovalMode> = {
  read: 'allow',
  write: 'ask',
  shell: 'ask',
  network: 'ask',
  delegate: 'allow',
};

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: 'Read files',
  write: 'Write & edit files',
  shell: 'Run shell commands',
  network: 'Search the web',
  delegate: 'Ask another profile',
};

export const TOOL_KINDS: ToolKind[] = ['read', 'write', 'shell', 'network', 'delegate'];

export interface EffectivePermissions {
  approval: Record<ToolKind, ApprovalMode>;
  trustedFolders: string[];
}

/** The web analogue of core's resolveAgentConfigForProfile merge:
 * defaults < global [agent] < profile [agent]; trusted folders are additive. */
export function resolveEffectivePermissions(
  global?: MarifoldAgentConfig,
  profile?: PartialAgentConfig,
): EffectivePermissions {
  return {
    approval: {
      ...DEFAULT_APPROVAL,
      ...(global?.approval ?? {}),
      ...(profile?.approval ?? {}),
    },
    trustedFolders: [...new Set([...(global?.trustedFolders ?? []), ...(profile?.trustedFolders ?? [])])],
  };
}
