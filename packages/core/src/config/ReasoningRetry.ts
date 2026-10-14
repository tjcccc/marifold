import type {
  AdapterCallOptions,
  AdapterResult,
  AdapterStreamEvent,
  Message,
  OutputSpec,
  PriestConfig,
  ProviderAdapter,
  ProviderToolDefinition,
} from '@priest-ai/core';

/** `provider/model` pairs that rejected a reasoning setting in this process. */
const rejected = new Set<string>();

/** Whether this model already rejected a reasoning setting, so none is sent. */
export function reasoningRejected(providerName: string, model: string): boolean {
  return rejected.has(`${providerName}/${model}`);
}

/**
 * Keeps Deep from ever breaking a reply. When a provider answers a request
 * with an HTTP 400 that names the reasoning setting (an effort level the
 * model lacks, or thinking on a model that cannot think), the call is retried
 * once without it and the model is remembered, so later calls skip it.
 * A stream is retried only when it failed before producing anything.
 */
export class ReasoningRetryProvider implements ProviderAdapter {
  readonly supportsProviderTool?: (tool: ProviderToolDefinition, config: PriestConfig) => boolean;
  readonly streamEvents?: (
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ) => AsyncGenerator<AdapterStreamEvent, void, unknown>;

  constructor(private readonly inner: ProviderAdapter, private readonly providerName: string) {
    if (inner.supportsProviderTool) {
      this.supportsProviderTool = (tool, config) => inner.supportsProviderTool!(tool, config);
    }
    if (inner.streamEvents) {
      this.streamEvents = (messages, config, outputSpec, options) =>
        this.retrying(config, next => inner.streamEvents!(messages, next, outputSpec, options));
    }
  }

  async complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec, options?: AdapterCallOptions): Promise<AdapterResult> {
    try {
      return await this.inner.complete(messages, config, outputSpec, options);
    } catch (error) {
      if (!this.rejects(config, error)) { throw error; }
      const result = await this.inner.complete(messages, { ...config, reasoning: undefined }, outputSpec, options);
      this.remember(config);
      return result;
    }
  }

  stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec, options?: AdapterCallOptions): AsyncGenerator<string, void, unknown> {
    return this.retrying(config, next => this.inner.stream(messages, next, outputSpec, options));
  }

  private async *retrying<T>(config: PriestConfig, call: (config: PriestConfig) => AsyncGenerator<T, void, unknown>): AsyncGenerator<T, void, unknown> {
    let started = false;
    try {
      for await (const item of call(config)) {
        started = true;
        yield item;
      }
    } catch (error) {
      if (started || !this.rejects(config, error)) { throw error; }
      let remembered = false;
      for await (const item of call({ ...config, reasoning: undefined })) {
        if (!remembered) { this.remember(config); remembered = true; }
        yield item;
      }
    }
  }

  /** Only a 400 naming a field marifold sets, never one about replayed reasoning items. */
  private rejects(config: PriestConfig, error: unknown): boolean {
    return Boolean(config.reasoning) && error instanceof Error && /\bHTTP 400:/.test(error.message)
      && /reasoning_effort|reasoning\.effort|\beffort\b|enable_thinking|does not support thinking/i.test(error.message);
  }

  /** Remembered only once the retry without the setting worked, so an
   * unrelated failure never switches Deep off for a model. */
  private remember(config: PriestConfig): void {
    rejected.add(`${this.providerName}/${config.model}`);
  }
}
