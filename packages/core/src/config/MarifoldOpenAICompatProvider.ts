import {
  AdapterCallOptions,
  AdapterResult,
  AdapterStreamEvent,
  Message,
  OpenAICompatProvider,
  OpenAIResponsesProvider,
  OutputSpec,
  PriestConfig,
  ProviderAdapter,
  ToolCall,
} from '@priest-ai/core';
import { randomUUID } from 'crypto';
import { proxyDispatcher } from '../util/proxy';
import { openAIChatCompletionsUrl, openAIResponsesUrl } from './OpenAICompatUrls';
import { isGitHubCopilotResponsesModelId } from './ProviderRegistry';

type OpenAICompatEndpoint = 'chat-completions' | 'responses';
const NATIVE_WEB_SEARCH_COMPAT_OPTION = 'marifold_native_web_search';

interface MarifoldOpenAICompatProviderOptions {
  providerName?: string;
  /** ChatGPT subscription account id, sent as `chatgpt-account-id` to the
   * Codex backend. */
  accountId?: string;
  /** Per-provider HTTP proxy (e.g. "http://127.0.0.1:7890"). Applied to both
   * Chat Completions and Responses requests. */
  proxy?: string;
}

/**
 * Marifold-owned routing and authentication around Priest's standard OpenAI
 * transports. Endpoint selection and subscription headers stay here; request
 * bodies, streaming events, reasoning continuation, and usage parsing belong
 * to the SDK providers.
 */
export class MarifoldOpenAICompatProvider implements ProviderAdapter {
  private readonly chatProvider: OpenAICompatProvider;
  private readonly responsesProvider: OpenAIResponsesProvider;
  /** Stable per-instance session id for Codex-backend requests. */
  private readonly sessionId = randomUUID();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly options: MarifoldOpenAICompatProviderOptions = {},
  ) {
    const dispatcher = proxyDispatcher(options.proxy);
    this.chatProvider = new OpenAICompatProvider(baseUrl, apiKey, {
      url: openAIChatCompletionsUrl(baseUrl, options),
      headers: this.copilotHeaders(),
      dispatcher,
    });
    this.responsesProvider = new OpenAIResponsesProvider(baseUrl, apiKey, {
      url: openAIResponsesUrl(baseUrl, options),
      headers: { ...this.copilotHeaders(), ...this.chatgptHeaders() },
      dispatcher,
    });
  }

  supportsProviderTool(tool: { type: 'web_search' }, config: PriestConfig): boolean {
    return this.options.providerName === 'chatgpt'
      && this.endpointForModel(config.model) === 'responses'
      && tool.type === 'web_search';
  }

  async complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    if (this.endpointForModel(config.model) !== 'responses') {
      return this.chatProvider.complete(messages, config, outputSpec, options);
    }
    const responsesConfig = this.responsesConfig(config, options);
    // The ChatGPT Codex backend is SSE-only ("Stream must be set to true").
    if (this.options.providerName === 'chatgpt') {
      return this.accumulateResponsesStream(messages, responsesConfig, outputSpec, options);
    }
    return this.responsesProvider.complete(messages, responsesConfig, outputSpec, options);
  }

  async *stream(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<string, void, unknown> {
    for await (const event of this.streamEvents(messages, config, outputSpec, options)) {
      if (event.type === 'text_delta') yield event.text;
    }
  }

  async *streamEvents(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<AdapterStreamEvent, void, unknown> {
    if (this.endpointForModel(config.model) === 'responses') {
      yield* this.responsesProvider.streamEvents(
        messages,
        this.responsesConfig(config, options),
        outputSpec,
        options,
      );
      return;
    }
    yield* this.chatProvider.streamEvents(messages, config, outputSpec, options);
  }

  private async accumulateResponsesStream(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    let text = '';
    const toolCalls: ToolCall[] = [];
    const summaryParts: string[] = [];
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let reasoning: AdapterResult['reasoning'];

    for await (const event of this.responsesProvider.streamEvents(messages, config, outputSpec, options)) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'reasoning_summary_delta':
          summaryParts.push(event.text);
          break;
        case 'tool_call_end':
          toolCalls.push(event.toolCall);
          break;
        case 'usage':
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          cachedInputTokens = event.cachedInputTokens;
          reasoningTokens = event.reasoningTokens;
          break;
        case 'finish':
          finishReason = event.finishReason;
          reasoning = event.reasoning;
          break;
      }
    }

    const streamedSummary = summaryParts.join('');
    if (streamedSummary && !reasoning?.summary) {
      reasoning = { ...reasoning, summary: streamedSummary };
    }

    return {
      text,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : (finishReason ?? 'stop'),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoning,
    };
  }

  private endpointForModel(model: string): OpenAICompatEndpoint {
    if (this.options.providerName === 'chatgpt') return 'responses';
    if (this.options.providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(model)) {
      return 'responses';
    }
    return 'chat-completions';
  }

  /** Preserve compatibility with Marifold callers that used `{think}` before
   * Priest 2.8 introduced the provider-neutral reasoning field. Raw `think`
   * must never leak into a Responses request. */
  private responsesConfig(config: PriestConfig, options?: AdapterCallOptions): PriestConfig {
    const providerOptions = { ...(config.providerOptions ?? {}) };
    const legacyThink = providerOptions['think'];
    const nativeWebSearch = providerOptions[NATIVE_WEB_SEARCH_COMPAT_OPTION] === true;
    delete providerOptions['think'];
    delete providerOptions[NATIVE_WEB_SEARCH_COMPAT_OPTION];

    // Priest 3.1 forwards providerTools and combines them with function tools.
    // Keep Marifold releases built against 3.0.x functional until that SDK is
    // the installed floor by supplying the equivalent Responses wire array.
    const forwardedProviderTools = (
      options as (AdapterCallOptions & { providerTools?: Array<{ type: 'web_search' }> }) | undefined
    )?.providerTools;
    if (nativeWebSearch && !forwardedProviderTools?.some(tool => tool.type === 'web_search')) {
      providerOptions['tools'] = [
        { type: 'web_search' },
        ...(options?.tools ?? []).map(tool => ({
          type: 'function',
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? {},
        })),
      ];
    }
    return {
      ...config,
      reasoning: config.reasoning ?? (legacyThink === true
        ? { enabled: true, effort: 'high' }
        : undefined),
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    };
  }

  private copilotHeaders(): Record<string, string> {
    if (this.options.providerName !== 'github_copilot') return {};
    return {
      'Editor-Version': 'marifold/0',
      'Editor-Plugin-Version': 'marifold/0',
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': 'marifold',
    };
  }

  private chatgptHeaders(): Record<string, string> {
    if (this.options.providerName !== 'chatgpt') return {};
    const headers: Record<string, string> = {
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
      session_id: this.sessionId,
    };
    if (this.options.accountId) headers['chatgpt-account-id'] = this.options.accountId;
    return headers;
  }
}
