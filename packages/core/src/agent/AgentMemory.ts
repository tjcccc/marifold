import { buildMemoryInstructions, shouldInjectMemoryInstructions, type MemoryControlPayloads } from '../memory/MemoryControls';

/** Profile memory as an agent run sees it: whether the profile uses memory,
 * what it remembers for this objective, and where a completed turn's lessons go. */
export interface AgentMemoryAccess {
  enabled(profile: string): boolean;
  load(profile: string, objective: string, thinking: boolean): string[];
  apply(profile: string, objective: string, controls: MemoryControlPayloads, sessionId?: string): void;
}

/** Context that frames recalled memory and, for non-trivial prompts, asks the
 * model to save or forget facts with hidden memory blocks. */
export function agentMemoryInstructions(objective: string): string[] {
  return [
    'Profile memory is app-owned context. Current user messages and profile rules outrank memory.',
    ...(shouldInjectMemoryInstructions(objective) ? [buildMemoryInstructions()] : []),
  ];
}
