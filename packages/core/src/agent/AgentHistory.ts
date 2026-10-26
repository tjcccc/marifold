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
  /** `summary`: the running summary of turns compacted away; comes first. */
  role: 'user' | 'assistant' | 'summary';
  content: string;
}

const HISTORY_HEADER = '## Earlier in this conversation\n\n';
const SUMMARY_LABEL = 'Summary of the earlier conversation: ';

/** Rough chars per token for budgeting prose. */
const CHARS_PER_TOKEN = 3;

/** Char budget for the history block: enough to grow to the compaction point,
 * so a summary (not truncation) keeps it in bounds. Undefined without a budget. */
export function historyBudgetChars(budgetTokens?: number, compactAtPercent?: number): number | undefined {
  if (!budgetTokens) { return undefined; }
  return Math.round(budgetTokens * CHARS_PER_TOKEN * (compactAtPercent ?? 100) / 100);
}

/** The last `count` turns (all when undefined), keeping a leading summary. */
export function windowTurns(turns: HistoryTurn[], count?: number): HistoryTurn[] {
  if (count == null) { return turns; }
  const summary = turns[0]?.role === 'summary' ? [turns[0]] : [];
  const rest = turns.slice(summary.length);
  return [...summary, ...rest.slice(Math.max(0, rest.length - count))];
}

/**
 * Build the "earlier conversation" context block from clean session turns,
 * keeping the most recent turns that fit within `budgetChars` (always at least
 * the single most recent turn) after a leading summary, which is always kept.
 * Returns undefined when there's nothing to add.
 */
export function buildHistoryContext(turns: HistoryTurn[], budgetChars: number): string | undefined {
  if (turns.length === 0 || budgetChars <= 0) { return undefined; }
  const summary = turns[0].role === 'summary' ? turns[0] : undefined;
  const kept: HistoryTurn[] = [];
  let used = summary ? summary.content.length + SUMMARY_LABEL.length : 0;
  for (let i = turns.length - 1; i >= (summary ? 1 : 0); i -= 1) {
    const turn = turns[i];
    const cost = turn.content.length + turn.role.length + 4;
    if (used + cost > budgetChars && kept.length > 0) { break; }
    kept.unshift(turn);
    used += cost;
  }
  const body = [
    ...(summary ? [`${SUMMARY_LABEL}${summary.content}`] : []),
    ...kept.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`),
  ].join('\n\n');
  return HISTORY_HEADER + body;
}
