import type { ReasoningConfig } from '@priest-ai/core';
import { isGitHubCopilotResponsesModelId } from './ProviderRegistry';

export interface ThinkTarget {
  providerName: string;
  providerType?: string;
  model: string;
  /** The model rejected a reasoning setting earlier (see ReasoningRetry). */
  rejected?: boolean;
}

/** Providers whose Chat Completions dialect marifold translates reasoning into. */
const EFFORT_CHAT_PROVIDERS = new Set(['xai']);
const SWITCH_CHAT_PROVIDERS = new Set(['bailian', 'alibaba_cloud']);
/** Ollama models that take thinking levels; others take true/false and treat
 * a level as "use the model default" (gemma4 then stops thinking). */
const OLLAMA_LEVEL_MODELS = /^gpt-oss(?::|$)/;

/**
 * Think on asks for medium effort and think off for low, sent explicitly so
 * the provider default (often high) never applies. High is never sent:
 * marifold is not a coding agent. Providers without levels get an on/off
 * switch; providers marifold has not verified get nothing.
 */
export function thinkReasoning(target: ThinkTarget, think: boolean): ReasoningConfig | undefined {
  if (!supportsThink(target)) { return undefined; }
  const effort = think ? 'medium' : 'low';
  const summary = think ? { summary: 'auto' as const } : {};
  if (target.providerType === 'ollama') {
    return OLLAMA_LEVEL_MODELS.test(target.model)
      ? { enabled: true, effort, ...summary }
      : { enabled: think, ...summary };
  }
  if (target.providerType === 'anthropic') {
    // Claude only thinks when asked, so off keeps the provider default.
    return think ? { enabled: true, effort, ...summary } : undefined;
  }
  if (usesResponsesEffort(target) || EFFORT_CHAT_PROVIDERS.has(target.providerName)) {
    return { enabled: true, effort, ...summary };
  }
  if (SWITCH_CHAT_PROVIDERS.has(target.providerName)) {
    return { enabled: think };
  }
  return undefined;
}

/** Whether the Think switch changes anything for this provider and model. */
export function supportsThink(target: ThinkTarget): boolean {
  if (target.rejected) { return false; }
  return target.providerType === 'ollama'
    || target.providerType === 'anthropic'
    || usesResponsesEffort(target)
    || EFFORT_CHAT_PROVIDERS.has(target.providerName)
    || SWITCH_CHAT_PROVIDERS.has(target.providerName);
}

/**
 * How an OpenAI-compatible provider's dialect carries reasoning on each wire
 * API. Priest's Chat Completions transport ignores `reasoning`, so xAI and
 * Bailian get their own body fields there; on Responses, xAI keeps only the
 * effort (summaries are unverified) and Bailian keeps its on/off field.
 */
export function providerReasoning(
  providerName: string | undefined,
  reasoning: ReasoningConfig,
  endpoint: 'chat-completions' | 'responses',
): { reasoning?: ReasoningConfig; fields: Record<string, string | boolean> } {
  if (providerName && SWITCH_CHAT_PROVIDERS.has(providerName)) {
    return { fields: reasoning.enabled === undefined ? {} : { enable_thinking: reasoning.enabled } };
  }
  if (providerName && EFFORT_CHAT_PROVIDERS.has(providerName) && reasoning.effort) {
    return endpoint === 'responses'
      ? { reasoning: { effort: reasoning.effort }, fields: {} }
      : { fields: { reasoning_effort: reasoning.effort } };
  }
  return endpoint === 'responses' ? { reasoning, fields: {} } : { fields: {} };
}

function usesResponsesEffort(target: ThinkTarget): boolean {
  return target.providerName === 'chatgpt'
    || (target.providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(target.model));
}
