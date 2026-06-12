import {
  AdapterCallOptions,
  AdapterResult,
  AdapterStreamEvent,
  createLinkedAbort,
  JSONValue,
  LinkedAbort,
  Message,
  OpenAICompatProvider,
  OutputSpec,
  parseToolArguments,
  PriestConfig,
  PriestError,
  ProviderAdapter,
  ToolCall,
  ToolChoice,
} from '@priest-ai/core';
import { openAIChatCompletionsUrl, openAIResponsesUrl } from './OpenAICompatUrls';
import { isGitHubCopilotResponsesModelId } from './ProviderRegistry';

type OpenAICompatEndpoint = 'chat-completions' | 'responses';

interface MarifoldOpenAICompatProviderOptions {
  providerName?: string;
}

interface ResponsesOutputItem {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  content?: Array<{
    type?: unknown;
    text?: unknown;
  }>;
}

interface ResponsesApiResponse {
  output_text?: unknown;
  output?: ResponsesOutputItem[];
  status?: unknown;
  incomplete_details?: {
    reason?: unknown;
  };
  error?: {
    message?: unknown;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ResponsesStreamEvent {
  type?: unknown;
  delta?: unknown;
  output_index?: unknown;
  item?: ResponsesOutputItem;
  error?: {
    message?: unknown;
  };
  response?: ResponsesApiResponse & {
    error?: {
      message?: unknown;
    };
  };
}

/**
 * OpenAI-compatible adapter with Marifold's endpoint routing: standard
 * chat-completions requests delegate to the SDK provider (custom URL and
 * Copilot headers), while GitHub Copilot responses-only models route to the
 * Responses API, including its flat tool wire format.
 */
export class MarifoldOpenAICompatProvider implements ProviderAdapter {
  private readonly chatProvider: OpenAICompatProvider;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly options: MarifoldOpenAICompatProviderOptions = {},
  ) {
    this.chatProvider = new OpenAICompatProvider(baseUrl, apiKey, {
      url: openAIChatCompletionsUrl(baseUrl, options),
      headers: this.copilotHeaders(),
    });
  }

  async complete(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    if (this.endpointForModel(config.model) === 'responses') {
      return this.completeResponses(messages, config, outputSpec, options);
    }
    return this.chatProvider.complete(messages, config, outputSpec, options);
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
      yield* this.streamEventsResponses(messages, config, outputSpec, options);
      return;
    }
    yield* this.chatProvider.streamEvents(messages, config, outputSpec, options);
  }

  private async completeResponses(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): Promise<AdapterResult> {
    const body = this.responsesRequestBody(messages, config, outputSpec, options, false);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    try {
      const response = await this.fetchResponse(openAIResponsesUrl(this.baseUrl, this.options), body, link.signal);
      const data = await response.json() as ResponsesApiResponse;

      if (data.error?.message) {
        throw PriestError.providerError('openai-compat', String(data.error.message));
      }

      const toolCalls = responsesToolCalls(data.output);
      return {
        text: responsesText(data),
        finishReason: toolCalls.length > 0 ? 'tool_calls' : responsesFinishReason(data),
        inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens,
        outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (err: unknown) {
      throw this.mapError(err, link, config);
    } finally {
      link.dispose();
    }
  }

  private async *streamEventsResponses(
    messages: Message[],
    config: PriestConfig,
    outputSpec?: OutputSpec,
    options?: AdapterCallOptions,
  ): AsyncGenerator<AdapterStreamEvent, void, unknown> {
    const body = this.responsesRequestBody(messages, config, outputSpec, options, true);
    const link = createLinkedAbort((config.timeoutSeconds ?? 60) * 1000, options?.signal);

    let response: Response;
    try {
      response = await this.fetchResponse(openAIResponsesUrl(this.baseUrl, this.options), body, link.signal);
    } catch (err: unknown) {
      link.dispose();
      throw this.mapError(err, link, config);
    }
    // Keep the caller signal wired for the body read; only the connect timeout ends here.
    link.clearTimer();

    if (!response.body) {
      link.dispose();
      throw PriestError.providerError('openai-compat', 'No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Responses API tool calls: output_item.added opens a function_call item
    // (keyed by output_index), function_call_arguments.delta accumulates, and
    // output_item.done finalizes with the complete arguments string.
    const openCalls = new Map<number, { toolIndex: number; callId?: string; name?: string; args: string }>();
    let toolCount = 0;
    let finishReason: string | undefined;
    let sawToolCalls = false;
    let usage: ResponsesApiResponse['usage'];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') break;
          let parsed: ResponsesStreamEvent;
          try {
            parsed = JSON.parse(data) as ResponsesStreamEvent;
          } catch {
            continue; // Ignore malformed provider events.
          }

          switch (parsed.type) {
            case 'response.output_text.delta':
              if (typeof parsed.delta === 'string' && parsed.delta) {
                yield { type: 'text_delta', text: parsed.delta };
              }
              break;
            case 'response.output_item.added': {
              const item = parsed.item;
              const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
              if (item?.type === 'function_call') {
                const toolIndex = toolCount++;
                const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
                const name = typeof item.name === 'string' ? item.name : undefined;
                openCalls.set(outputIndex, { toolIndex, callId, name, args: '' });
                yield { type: 'tool_call_start', index: toolIndex, id: callId, name };
              }
              break;
            }
            case 'response.function_call_arguments.delta': {
              const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
              const state = openCalls.get(outputIndex);
              if (state && typeof parsed.delta === 'string' && parsed.delta) {
                state.args += parsed.delta;
                yield { type: 'tool_call_delta', index: state.toolIndex, argumentsDelta: parsed.delta };
              }
              break;
            }
            case 'response.output_item.done': {
              const item = parsed.item;
              const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
              const state = openCalls.get(outputIndex);
              if (state && item?.type === 'function_call') {
                openCalls.delete(outputIndex);
                sawToolCalls = true;
                const rawArgs = typeof item.arguments === 'string' && item.arguments ? item.arguments : state.args;
                yield {
                  type: 'tool_call_end',
                  index: state.toolIndex,
                  toolCall: {
                    id: state.callId ?? `call_${state.toolIndex}`,
                    name: (typeof item.name === 'string' && item.name) || state.name || '',
                    arguments: parseToolArguments(rawArgs),
                  },
                };
              }
              break;
            }
            case 'response.completed':
              usage = parsed.response?.usage ?? usage;
              finishReason = parsed.response ? responsesFinishReason(parsed.response) : finishReason;
              break;
            case 'error':
              throw PriestError.providerError('openai-compat', String(parsed.error?.message ?? 'Responses stream error'));
            case 'response.failed':
              throw PriestError.providerError('openai-compat', String(parsed.response?.error?.message ?? 'Responses stream failed'));
          }
        }
      }

      if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
        yield { type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      }
      yield { type: 'finish', finishReason: sawToolCalls ? 'tool_calls' : (finishReason ?? 'stop') };
    } catch (err: unknown) {
      throw this.mapError(err, link, config);
    } finally {
      reader.releaseLock();
      link.dispose();
    }
  }

  private responsesRequestBody(
    messages: Message[],
    config: PriestConfig,
    outputSpec: OutputSpec | undefined,
    options: AdapterCallOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      input: toResponsesInput(messages),
      stream,
      ...(config.providerOptions ?? {}),
    };
    if (outputSpec?.jsonSchema != null) {
      body['text'] = {
        format: {
          type: 'json_schema',
          name: outputSpec.jsonSchemaName ?? 'response',
          schema: outputSpec.jsonSchema,
          strict: outputSpec.jsonSchemaStrict ?? false,
        },
      };
    } else if (outputSpec?.providerFormat === 'json') {
      body['text'] = { format: { type: 'json_object' } };
    }
    if (config.maxOutputTokens !== undefined) {
      body['max_output_tokens'] = config.maxOutputTokens;
    }
    if (options?.tools && options.tools.length > 0) {
      // Responses API uses a flat tool shape, unlike chat-completions.
      body['tools'] = options.tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? {},
      }));
      if (options.toolChoice !== undefined) {
        body['tool_choice'] = mapResponsesToolChoice(options.toolChoice);
      }
    }
    return body;
  }

  private async fetchResponse(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
    }
    return response;
  }

  private mapError(err: unknown, link: LinkedAbort, config: PriestConfig): Error {
    if (err instanceof PriestError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      if (link.callerAborted()) return PriestError.requestAborted('openai-compat');
      if (link.timedOut()) return PriestError.providerTimeout('openai-compat', config.timeoutSeconds ?? 60);
    }
    return PriestError.providerError('openai-compat', String(err));
  }

  private endpointForModel(model: string): OpenAICompatEndpoint {
    if (this.options.providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(model)) {
      return 'responses';
    }
    return 'chat-completions';
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

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return { ...headers, ...this.copilotHeaders() };
  }
}

/**
 * Translate adapter messages to Responses API input items. Tool calls become
 * function_call items and tool results become function_call_output items.
 */
function toResponsesInput(messages: Message[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: messageText(m.content) });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const text = messageText(m.content);
      if (text.length > 0) input.push({ role: 'assistant', content: text });
      for (const call of m.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    input.push({ role: m.role, content: messageText(m.content) });
  }
  return input;
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ');
}

function mapResponsesToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function responsesToolCalls(output: ResponsesOutputItem[] | undefined): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output ?? []) {
    if (item.type !== 'function_call') continue;
    const name = typeof item.name === 'string' ? item.name : undefined;
    if (!name) continue;
    const rawArgs = typeof item.arguments === 'string' ? item.arguments : '';
    calls.push({
      id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${calls.length}`,
      name,
      arguments: parseToolArguments(rawArgs) as Record<string, JSONValue>,
    });
  }
  return calls;
}

function responsesText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === 'string') return data.output_text;
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== undefined && item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type !== undefined && content.type !== 'output_text' && content.type !== 'text') continue;
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

function responsesFinishReason(data: ResponsesApiResponse): string | undefined {
  if (data.status === 'completed') return 'stop';
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    return typeof reason === 'string' ? reason : 'incomplete';
  }
  return typeof data.status === 'string' ? data.status : undefined;
}
