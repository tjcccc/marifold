/**
 * Bounded cross-objective memory for agent runs.
 *
 * Agent mode is stateless by default: the engine has no session store, so a
 * regular objective sees only `system + objective` and can't reference a prior
 * turn ("save the above prompt" → it can't see the prompt). For NON-lean tasks
 * we inject a bounded window of the recent clean session pairs (objective →
 * final answer, the ones `appendExchange` persists — never raw tool framing) so
 * the agent has working memory of the conversation. Lean/skill runs stay
 * stateless (isolated, subagent-style).
 *
 * Deterministic window — keeps the most recent turns within a char budget, no
 * model call, no fidelity-loss from summarization. The clean pairs are already
 * compact, so a window is a sound, reliable bound (summarization can come later
 * if depth ever demands it).
 */

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

const HISTORY_HEADER = '## Earlier in this conversation\n\n';

/**
 * Build the "earlier conversation" context block from clean session turns,
 * keeping the most recent turns that fit within `budgetChars` (always at least
 * the single most recent turn). Returns undefined when there's nothing to add.
 */
export function buildHistoryContext(turns: HistoryTurn[], budgetChars: number): string | undefined {
  if (turns.length === 0 || budgetChars <= 0) return undefined;
  const kept: HistoryTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const cost = turn.content.length + turn.role.length + 4;
    if (used + cost > budgetChars && kept.length > 0) break;
    kept.unshift(turn);
    used += cost;
  }
  const body = kept.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  return HISTORY_HEADER + body;
}
