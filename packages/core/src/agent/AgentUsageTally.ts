import type { UsageInfo } from '@priest-ai/core';
import type { AgentUsage } from './AgentEvents';
import type { AgentEngine } from './AgentRunner';

/** Wrap an engine so each model call's token usage accrues into `total`. */
export function withUsageTally(engine: AgentEngine, total: AgentUsage): AgentEngine {
  return {
    run: async (request, options) => {
      const response = await engine.run(request, options);
      addUsage(total, response.usage);
      return response;
    },
  };
}

function addUsage(total: AgentUsage, usage?: UsageInfo): void {
  if (!usage) { return; }
  if (usage.inputTokens != null) { total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens; }
  if (usage.outputTokens != null) { total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens; }
  if (usage.cachedInputTokens != null) { total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens; }
  if (usage.reasoningTokens != null) { total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens; }
  const turnTotal = usage.totalTokens ?? sumDefined(usage.inputTokens, usage.outputTokens);
  if (turnTotal != null) { total.totalTokens = (total.totalTokens ?? 0) + turnTotal; }
  if (usage.estimatedCostUSD != null) { total.estimatedCostUSD = (total.estimatedCostUSD ?? 0) + usage.estimatedCostUSD; }
}

function sumDefined(a?: number, b?: number): number | undefined {
  if (a == null && b == null) { return undefined; }
  return (a ?? 0) + (b ?? 0);
}

export function hasUsage(usage: AgentUsage): boolean {
  return usage.inputTokens != null
    || usage.outputTokens != null
    || usage.totalTokens != null
    || usage.cachedInputTokens != null
    || usage.reasoningTokens != null
    || usage.estimatedCostUSD != null;
}
