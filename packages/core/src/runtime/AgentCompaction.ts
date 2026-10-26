import { buildSummaryMessages, planCompaction, SUMMARY_MAX_OUTPUT_TOKENS, type Turn } from '@priest-ai/core';
import type { HistoryTurn } from '../agent/AgentHistory';
import type { AgentEvent, AgentUsage } from '../agent/AgentEvents';
import type { SessionResolver } from '../sessions/SessionResolver';
import type { MarifoldResolvedSettings } from './MarifoldTypes';
import type { ProviderEngines } from './ProviderEngines';

export interface AgentCompactionHost {
  sessionResolver: SessionResolver;
  engines: ProviderEngines;
  /** Recent turns kept verbatim; older ones fold into the summary. */
  keepTurns: number;
  log?: (message: string) => void;
}

/**
 * Running summaries for agent sessions. Agent runs replay clean session pairs
 * as history (no Priest session), so they fold older pairs into the same
 * `__compaction` summary Priest uses for chat, writing only the metadata, so
 * turn rows (and their ids) are never rewritten.
 */
export class AgentCompaction {
  private readonly running = new Set<string>();

  constructor(private readonly host: AgentCompactionHost) {}

  /** After a finished agent turn (with that run's settings, so a session
   * budget applies): once the run's fullest model call passed the configured
   * share of the budget, compact before the run reports `done`, so clients
   * show the compaction as it happens. A failure only reports; the turn stays saved. */
  async *afterTurn(sessionId: string, settings: MarifoldResolvedSettings, usage: AgentUsage, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    const peak = usage.contextTokens;
    if (peak === undefined) { return; }
    if (!settings.maxContextTokens || !settings.compactAtPercent) { return; }
    if (peak <= settings.maxContextTokens * settings.compactAtPercent / 100) { return; }
    yield { type: 'compaction', status: 'running' };
    try {
      const summarizedTurns = await this.compact(sessionId, settings, signal);
      if (summarizedTurns !== undefined) { yield { type: 'compaction', status: 'completed', summarizedTurns }; return; }
      yield { type: 'compaction', status: 'skipped' };
    } catch (error) {
      const message = signal?.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error);
      this.host.log?.(`Could not compact session ${sessionId}: ${message}`);
      yield { type: 'compaction', status: 'failed', message };
    }
  }

  /** Fold every turn before the kept tail into the summary; resolves to the
   * number of turns the summary now covers. Undefined when there is nothing
   * new to fold or a compaction of this session is already running. */
  async compact(sessionId: string, settings: MarifoldResolvedSettings, signal?: AbortSignal): Promise<number | undefined> {
    if (this.running.has(sessionId)) { return undefined; }
    this.running.add(sessionId);
    try {
      const turns = (this.host.sessionResolver.get(sessionId)?.turns ?? []) as unknown as Turn[];
      const existing = this.host.sessionResolver.compaction(sessionId) ?? {};
      const existingThrough = existing.summarizedThrough ?? 0;
      const plan = planCompaction(turns, existingThrough, this.host.keepTurns);
      if (!plan) { return undefined; }
      const [system, user] = buildSummaryMessages(existing.summary, plan.toSummarize);
      await this.host.engines.refreshCredentials(settings.provider);
      const config = this.host.engines.priestConfig(settings);
      const response = await this.host.engines.create(settings.provider, false, false).run({
        config: { ...config, maxOutputTokens: config.maxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS },
        profile: settings.profile,
        prompt: textOf(user.content),
        context: [textOf(system.content)],
      }, signal ? { signal } : undefined);
      const summary = (response.text ?? '').trim();
      if (!summary) { throw new Error('the model returned no summary'); }
      // An edit or truncation while the summary was written: drop it.
      const now = this.host.sessionResolver.get(sessionId)?.turns ?? [];
      if (now.length < plan.summarizedThrough || plan.toSummarize.some((turn, index) => now[existingThrough + index]?.content !== turn.content)
        || (this.host.sessionResolver.compaction(sessionId)?.summarizedThrough ?? 0) !== existingThrough) { return undefined; }
      this.host.sessionResolver.compaction(sessionId, { summary, summarizedThrough: plan.summarizedThrough });
      return plan.summarizedThrough;
    } finally {
      this.running.delete(sessionId);
    }
  }
}

/** Agent history for a session: its running summary (when one covers these
 * turns) followed by the user/assistant pairs after it. */
export function sessionHistory(turns: Array<{ role: string; content: string }>, compaction?: { summary?: string; summarizedThrough?: number }): HistoryTurn[] {
  const through = compaction?.summary && compaction.summarizedThrough && compaction.summarizedThrough <= turns.length
    ? compaction.summarizedThrough
    : 0;
  return [
    ...(through > 0 ? [{ role: 'summary' as const, content: compaction!.summary! }] : []),
    ...turns.slice(through)
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
  ];
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === 'string' ? content : content.map(block => block.text ?? '').join('');
}
