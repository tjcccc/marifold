import { MarifoldError } from '../errors/MarifoldError';

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
  /** `summary`: the running summary of turns compacted away; comes first.
   * `reply`: an earlier answer to the message this run answers (when several
   * profiles answer one message); replies come last and are always kept. */
  role: 'user' | 'assistant' | 'summary' | 'reply';
  content: string;
  /** Who gave an assistant or reply turn, when the session knows. */
  speaker?: string;
}

/** Which saved user turn a run answers instead of appending an exchange:
 * `replace` an edited exchange, or add a `reply` to a saved message. */
export interface SessionTurnTarget {
  kind: 'replace' | 'reply';
  userTurnIndex: number;
}

/** A run's session target from its options; an edit and a reply exclude each other. */
export function sessionTurnTarget(options: { replaceUserTurnIndex?: number; replyToUserTurnIndex?: number }): SessionTurnTarget | undefined {
  if (options.replaceUserTurnIndex !== undefined && options.replyToUserTurnIndex !== undefined) {
    throw MarifoldError.configInvalid('A run either replaces an exchange or replies to a message, not both.');
  }
  for (const index of [options.replaceUserTurnIndex, options.replyToUserTurnIndex]) {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) { throw MarifoldError.configInvalid('userTurnIndex must be a non-negative integer.'); }
  }
  if (options.replaceUserTurnIndex !== undefined) { return { kind: 'replace', userTurnIndex: options.replaceUserTurnIndex }; }
  return options.replyToUserTurnIndex === undefined ? undefined : { kind: 'reply', userTurnIndex: options.replyToUserTurnIndex };
}

const HISTORY_HEADER = '## Earlier in this conversation\n\n';
const REPLIES_HEADER = '## Replies already given to the current message\n\n';
const SUMMARY_LABEL = 'Summary of the earlier conversation: ';
const speakersNote = (self?: string) => `(${self ? `You are ${self}. ` : ''}Replies labelled with another profile's name come from other assistants in this conversation; yours are labelled Assistant.)`;

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
  const replies = turns.filter(turn => turn.role === 'reply');
  const rest = turns.slice(summary.length).filter(turn => turn.role !== 'reply');
  return [...summary, ...rest.slice(Math.max(0, rest.length - count)), ...replies];
}

/**
 * Build the "earlier conversation" context block from clean session turns,
 * keeping the most recent turns that fit within `budgetChars` (always at least
 * the single most recent turn) after a leading summary, which is always kept,
 * like the replies already given to the current message. Another profile's
 * answers are labelled with its name; `self` (the answering profile) keeps
 * `Assistant`. Returns undefined when there's nothing to add.
 */
export function buildHistoryContext(turns: HistoryTurn[], budgetChars: number, self?: string): string | undefined {
  if (turns.length === 0 || budgetChars <= 0) { return undefined; }
  const label = (turn: HistoryTurn) => turn.role === 'user' ? 'User' : turn.speaker && turn.speaker !== self ? turn.speaker : 'Assistant';
  const summary = turns[0].role === 'summary' ? turns[0] : undefined;
  const replies = turns.filter(turn => turn.role === 'reply');
  const earlier = turns.slice(summary ? 1 : 0).filter(turn => turn.role !== 'reply');
  const kept: HistoryTurn[] = [];
  let used = (summary ? summary.content.length + SUMMARY_LABEL.length : 0) + replies.reduce((sum, turn) => sum + turn.content.length + label(turn).length + 4, 0);
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const turn = earlier[i];
    const cost = turn.content.length + label(turn).length + 4;
    if (used + cost > budgetChars && kept.length > 0) { break; }
    kept.unshift(turn);
    used += cost;
  }
  const lines = (list: HistoryTurn[]) => list.map(turn => `${label(turn)}: ${turn.content}`);
  const othersSpeak = [...kept, ...replies].some(turn => turn.role !== 'user' && label(turn) !== 'Assistant');
  const blocks = [
    ...(summary || kept.length > 0 ? [HISTORY_HEADER + [...(summary ? [`${SUMMARY_LABEL}${summary.content}`] : []), ...lines(kept)].join('\n\n')] : []),
    ...(replies.length > 0 ? [REPLIES_HEADER + lines(replies).join('\n\n')] : []),
    ...(othersSpeak ? [speakersNote(self)] : []),
  ];
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}
