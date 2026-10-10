import {
  extractPromptForgetQueries,
  extractPromptMemoryInputs,
  type MemoryControlPayloads,
} from './MemoryControls';
import type { MemoryStore } from './MemoryStore';

/** Apply what one completed turn taught: the model's hidden memory_save /
 * memory_forget blocks, then the prompt's explicit statements as a fallback
 * (names, favorites, preferences, "forget …"), and keep short-term memory bounded. */
export function applyTurnMemory(
  store: MemoryStore,
  profile: string,
  prompt: string,
  controls: MemoryControlPayloads,
  options: { sessionId?: string; sizeLimit: number; promptForgets?: boolean },
): void {
  const saved = store.applySavePayloads(profile, controls.savePayloads, { sessionId: options.sessionId });
  store.applyForgetPayloads(profile, controls.forgetPayloads);
  // Agent objectives are tasks ("remove the name column"), so only chat reads
  // forgets from the prompt; agents forget through the model's memory_forget.
  for (const query of options.promptForgets === false ? [] : extractPromptForgetQueries(prompt)) {
    store.forget(profile, query);
  }
  // The model's own wording wins: the fallback skips facts it saved this turn.
  const savedKeys = new Set(saved.entries.flatMap(entry => entry.conflict_key ? [entry.conflict_key] : []));
  const fallback = extractPromptMemoryInputs(prompt).filter(input => !input.conflictKey || !savedKeys.has(input.conflictKey));
  store.save(profile, fallback, { sessionId: options.sessionId });
  store.trimShortTerm(profile, options.sizeLimit);
}
