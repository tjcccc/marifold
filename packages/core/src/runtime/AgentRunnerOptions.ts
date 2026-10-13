import type { AgentRunnerDeps } from '../agent/AgentRunner';

/** Per-run wiring for `MarifoldRuntime.createAgentRunner`. */
export interface AgentRunnerOptions {
  createWorkspace?: AgentRunnerDeps['createWorkspace'];
  listArtifacts?: AgentRunnerDeps['listArtifacts'];
  deviceInstructions?: string;
  contextInstructions?: string[];
  webSearch?: boolean;
  readOnlyFolders?: string[];
  readOnlyFiles?: string[];
  allowExternalReadOnlyFolders?: boolean;
  /** Limits on this device's Marifold state for a run requested from another
   * workspace device. Local runs have no hard block there. */
  stateAccess?: AgentRunnerDeps['stateAccess'];
}
