import { MarifoldError } from '../errors/MarifoldError';
import type { ProviderModelList } from './ProviderInspector';

/** Budget used while a model's window is unknown: the provider does not
 * report one, or its listing has not been fetched yet. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** `max_context_tokens = "auto"` (also the default when unset): budget by the
 * model's own context window. */
export const AUTO_CONTEXT_TOKENS = 'auto';
export type ContextTokensSetting = number | typeof AUTO_CONTEXT_TOKENS;

/** Registry providers whose model listing reports context windows. Others
 * (DashScope, Ollama, custom endpoints) are never asked. */
const REPORTING_PROVIDERS = new Set(['xai', 'chatgpt', 'github_copilot', 'openrouter']);
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/**
 * In-memory context windows from provider model listings. Lookups stay
 * synchronous: an unknown provider is fetched in the background and its
 * windows apply from the next turn on.
 */
export class ModelWindows {
  private readonly windows = new Map<string, Record<string, number>>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly list: (provider: string) => Promise<ProviderModelList>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The model's reported window, or undefined while unknown. Starts a
   * background refresh when the provider's listing is missing or stale. */
  lookup(provider: string, model: string): number | undefined {
    if (!REPORTING_PROVIDERS.has(provider)) { return undefined; }
    void this.refresh(provider);
    return this.windows.get(provider)?.[model];
  }

  /** Fetch the provider's listing unless it is fresh (or failed recently). */
  refresh(provider: string): Promise<void> {
    const pending = this.inFlight.get(provider);
    if (pending) { return pending; }
    const fetchedAt = this.fetchedAt.get(provider);
    const fresh = this.windows.has(provider) ? REFRESH_MS : RETRY_MS;
    if (fetchedAt !== undefined && this.now() - fetchedAt < fresh) { return Promise.resolve(); }
    const task = this.list(provider)
      .then(result => {
        if (result.reachable === true) { this.windows.set(provider, result.contextWindows ?? {}); }
      }, () => undefined)
      .finally(() => {
        this.fetchedAt.set(provider, this.now());
        this.inFlight.delete(provider);
      });
    this.inFlight.set(provider, task);
    return task;
  }
}

/** The token budget a setting means for this model: a number is used as is
 * (0 turns compaction off); `auto` or unset uses the model's window. */
export function resolveContextTokens(setting: ContextTokensSetting | undefined, window: () => number | undefined): number | undefined {
  if (typeof setting === 'number') { return setting > 0 ? setting : undefined; }
  return window() ?? FALLBACK_CONTEXT_WINDOW;
}


/** Parse `max_context_tokens`: `"auto"`, or a token count (0 = off). */
export function parseContextTokens(value: unknown, label: string): ContextTokensSetting | undefined {
  if (value === undefined) { return undefined; }
  if (value === AUTO_CONTEXT_TOKENS) { return AUTO_CONTEXT_TOKENS; }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) { return value; }
  throw MarifoldError.configInvalid(`Expected ${label} to be "auto" or a token count (0 turns compaction off).`);
}

/** Compact once a turn's context passes this share of the budget. */
export const DEFAULT_COMPACT_AT_PERCENT = 90;

/** Parse `compact_at_percent`: 10–100, or 0 = never compact automatically.
 * 1–9 are refused so a typo cannot silently turn compaction off. */
export function parseCompactAtPercent(value: unknown, label: string): number | undefined {
  if (value === undefined) { return undefined; }
  if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 10 && value <= 100))) { return value; }
  throw MarifoldError.configInvalid(`Expected ${label} to be 0 (off) or a percentage from 10 to 100.`);
}

/** The effective compaction percentage, or undefined when it is off. */
export function resolveCompactAtPercent(setting: number | undefined): number | undefined {
  const percent = setting ?? DEFAULT_COMPACT_AT_PERCENT;
  return percent > 0 ? percent : undefined;
}
