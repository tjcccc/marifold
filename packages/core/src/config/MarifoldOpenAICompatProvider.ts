import {
  AdapterResult,
  Message,
  OutputSpec,
  PriestConfig,
  PriestError,
  ProviderAdapter,
} from '@priest-ai/core';
import { openAIChatCompletionsUrl, openAIResponsesUrl } from './OpenAICompatUrls';
import { isGitHubCopilotResponsesModelId } from './ProviderRegistry';

type FinishReason = 'stop' | 'length' | 'content_filter' | null;
type OpenAICompatEndpoint = 'chat-completions' | 'responses';

interface MarifoldOpenAICompatProviderOptions {
  providerName?: string;
}

interface ResponsesApiResponse {
  output_text?: unknown;
  output?: Array<{
    type?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  }>;
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
  error?: {
    message?: unknown;
  };
  response?: {
    error?: {
      message?: unknown;
    };
  };
}

export class MarifoldOpenAICompatProvider implements ProviderAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly options: MarifoldOpenAICompatProviderOptions = {},
  ) {}

  async complete(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    const endpoint = this.endpointForModel(config.model);
    if (endpoint === 'responses') {
      return this.completeResponses(messages, config, outputSpec);
    }
    return this.completeChatCompletions(messages, config, outputSpec);
  }

  async *stream(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const endpoint = this.endpointForModel(config.model);
    if (endpoint === 'responses') {
      yield* this.streamResponses(messages, config, outputSpec);
      return;
    }
    yield* this.streamChatCompletions(messages, config, outputSpec);
  }

  private async completeChatCompletions(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    const body = this.chatCompletionsRequestBody(messages, config, outputSpec, false);
    const response = await this.fetchResponse(config, openAIChatCompletionsUrl(this.baseUrl, this.options), body);

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: FinishReason }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const finishReason = data.choices[0]?.finish_reason ?? undefined;
    const inputTokens = data.usage?.prompt_tokens;
    const outputTokens = data.usage?.completion_tokens;

    return {
      text: data.choices[0]?.message?.content ?? '',
      finishReason,
      inputTokens,
      outputTokens,
    };
  }

  private async completeResponses(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): Promise<AdapterResult> {
    const body = this.responsesRequestBody(messages, config, outputSpec, false);
    const response = await this.fetchResponse(config, openAIResponsesUrl(this.baseUrl, this.options), body);
    const data = await response.json() as ResponsesApiResponse;

    if (data.error?.message) {
      throw PriestError.providerError('openai-compat', String(data.error.message));
    }

    return {
      text: responsesText(data),
      finishReason: responsesFinishReason(data),
      inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens,
      outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens,
    };
  }

  private async *streamChatCompletions(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const body = this.chatCompletionsRequestBody(messages, config, outputSpec, true);
    const response = await this.fetchResponse(config, openAIChatCompletionsUrl(this.baseUrl, this.options), body);

    if (!response.body) throw PriestError.providerError('openai-compat', 'No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data) as { choices: Array<{ delta?: { content?: string } }> };
            const chunk = parsed.choices[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // Ignore malformed provider events.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *streamResponses(messages: Message[], config: PriestConfig, outputSpec?: OutputSpec): AsyncGenerator<string, void, unknown> {
    const body = this.responsesRequestBody(messages, config, outputSpec, true);
    const response = await this.fetchResponse(config, openAIResponsesUrl(this.baseUrl, this.options), body);

    if (!response.body) throw PriestError.providerError('openai-compat', 'No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          if (data === '[DONE]') return;
          const chunk = parseResponsesStreamData(data);
          if (chunk) yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private chatCompletionsRequestBody(
    messages: Message[],
    config: PriestConfig,
    outputSpec: OutputSpec | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream,
      ...(config.providerOptions ?? {}),
    };
    if (outputSpec?.jsonSchema != null) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: outputSpec.jsonSchemaName ?? 'response',
          schema: outputSpec.jsonSchema,
          strict: outputSpec.jsonSchemaStrict ?? false,
        },
      };
    } else if (outputSpec?.providerFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }
    if (config.maxOutputTokens !== undefined) {
      body['max_tokens'] = config.maxOutputTokens;
    }
    return body;
  }

  private responsesRequestBody(
    messages: Message[],
    config: PriestConfig,
    outputSpec: OutputSpec | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      input: messages.map(message => ({ role: message.role, content: message.content })),
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
    return body;
  }

  private async fetchResponse(config: PriestConfig, url: string, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds ?? 60) * 1000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw PriestError.providerTimeout('openai-compat', config.timeoutSeconds ?? 60);
      }
      throw PriestError.providerError('openai-compat', String(err));
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw PriestError.providerError('openai-compat', `HTTP ${response.status}: ${errText}`);
    }

    return response;
  }

  private endpointForModel(model: string): OpenAICompatEndpoint {
    if (this.options.providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(model)) {
      return 'responses';
    }
    return 'chat-completions';
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.options.providerName === 'github_copilot') {
      headers['Editor-Version'] = 'marifold/0';
      headers['Editor-Plugin-Version'] = 'marifold/0';
      headers['Copilot-Integration-Id'] = 'vscode-chat';
      headers['User-Agent'] = 'marifold';
    }
    return headers;
  }
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

function parseResponsesStreamData(data: string): string | undefined {
  let parsed: ResponsesStreamEvent;
  try {
    parsed = JSON.parse(data) as ResponsesStreamEvent;
  } catch {
    return undefined;
  }

  if (parsed.type === 'response.output_text.delta') {
    return typeof parsed.delta === 'string' ? parsed.delta : undefined;
  }
  if (parsed.type === 'error') {
    throw PriestError.providerError('openai-compat', String(parsed.error?.message ?? 'Responses stream error'));
  }
  if (parsed.type === 'response.failed') {
    throw PriestError.providerError('openai-compat', String(parsed.response?.error?.message ?? 'Responses stream failed'));
  }
  return undefined;
}
