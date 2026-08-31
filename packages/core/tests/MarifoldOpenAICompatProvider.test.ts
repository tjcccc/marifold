import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldOpenAICompatProvider } from '../src/config/MarifoldOpenAICompatProvider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MarifoldOpenAICompatProvider', () => {
  it('routes GitHub Copilot gpt-5.4-mini complete calls through Responses API', async () => {
    let requestUrl: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello mini' }],
          },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 2,
        },
      }), { status: 200 });
    }));

    const provider = new MarifoldOpenAICompatProvider('https://api.githubcopilot.com', 'tid=test', {
      providerName: 'github_copilot',
    });
    const result = await provider.complete([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Hello' },
    ], {
      provider: 'github_copilot',
      model: 'gpt-5.4-mini',
      maxOutputTokens: 50,
    });

    expect(result).toMatchObject({
      text: 'hello mini',
      finishReason: 'stop',
      inputTokens: 7,
      outputTokens: 2,
    });
    expect(requestUrl).toBe('https://api.githubcopilot.com/responses');
    expect(requestBody).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: false,
      max_output_tokens: 50,
    });
    expect(requestBody?.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'You are concise.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ]);
  });

  it('streams GitHub Copilot gpt-5.4-mini Responses API text deltas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'hello ' },
      { type: 'response.output_text.delta', delta: 'mini' },
      { type: 'response.completed' },
    ])));

    const provider = new MarifoldOpenAICompatProvider('https://api.githubcopilot.com', 'tid=test', {
      providerName: 'github_copilot',
    });
    const chunks: string[] = [];
    for await (const chunk of provider.stream([
      { role: 'user', content: 'Hello' },
    ], {
      provider: 'github_copilot',
      model: 'gpt-5.4-mini',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello ', 'mini']);
  });

  it('keeps GitHub Copilot chat-completions models on the chat completions endpoint', async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello chat' }, finish_reason: 'stop' }],
      }), { status: 200 });
    }));

    const provider = new MarifoldOpenAICompatProvider('https://api.githubcopilot.com', 'tid=test', {
      providerName: 'github_copilot',
    });
    const result = await provider.complete([
      { role: 'user', content: 'Hello' },
    ], {
      provider: 'github_copilot',
      model: 'gpt-5.4',
    });

    expect(result.text).toBe('hello chat');
    expect(requestUrl).toBe('https://api.githubcopilot.com/chat/completions');
  });

  it('routes xAI native web search through the Responses API', async () => {
    let requestUrl: string | undefined;
    let requestHeaders: Record<string, string> | undefined;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = init?.headers as Record<string, string>;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Fresh Grok answer.' }],
        }],
      }), { status: 200 });
    }));

    const provider = new MarifoldOpenAICompatProvider('https://api.x.ai/v1', 'xai-token', {
      providerName: 'xai',
    });
    const config = {
      provider: 'xai',
      model: 'grok-4.6',
      maxOutputTokens: 100,
      providerOptions: { marifold_native_web_search: true },
    };
    const result = await provider.complete([{ role: 'user', content: 'What is new?' }], config, undefined, {
      providerTools: [{ type: 'web_search' }],
    });

    expect(provider.supportsProviderTool({ type: 'web_search' }, config)).toBe(true);
    expect(result.text).toBe('Fresh Grok answer.');
    expect(requestUrl).toBe('https://api.x.ai/v1/responses');
    expect(requestHeaders).toMatchObject({ Authorization: 'Bearer xai-token' });
    expect(requestBody).toMatchObject({
      model: 'grok-4.6',
      stream: false,
      max_output_tokens: 100,
      tools: [{ type: 'web_search' }],
    });
  });

  it('keeps ordinary xAI calls on Chat Completions', async () => {
    let requestUrl: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Ordinary answer.' }, finish_reason: 'stop' }],
      }), { status: 200 });
    }));

    const provider = new MarifoldOpenAICompatProvider('https://api.x.ai/v1', 'xai-token', {
      providerName: 'xai',
    });
    const config = { provider: 'xai', model: 'grok-4.6' };
    const result = await provider.complete([{ role: 'user', content: 'Hello' }], config);

    expect(provider.supportsProviderTool({ type: 'web_search' }, config)).toBe(false);
    expect(result.text).toBe('Ordinary answer.');
    expect(requestUrl).toBe('https://api.x.ai/v1/chat/completions');
  });

  it('routes ChatGPT subscription calls to the Codex backend with account headers, store:false, and forced streaming', async () => {
    let requestUrl: string | undefined;
    let requestHeaders: Record<string, string> | undefined;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = init?.headers as Record<string, string>;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The Codex backend is SSE-only — return a stream, mirroring the real API.
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'response.completed' },
      ]);
    }));

    const provider = new MarifoldOpenAICompatProvider('https://chatgpt.com/backend-api/codex', 'access-tok', {
      providerName: 'chatgpt',
      accountId: 'acct_123',
    });
    // complete() must still work even though the backend rejects non-streaming —
    // it drives the streaming path and accumulates.
    const result = await provider.complete([{ role: 'user', content: 'Hello' }], {
      provider: 'chatgpt',
      model: 'gpt-5-codex',
      maxOutputTokens: 50,
    });

    expect(result.text).toBe('hi');
    // Codex backend root serves /responses directly (no /v1 segment).
    expect(requestUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(requestHeaders).toMatchObject({
      Authorization: 'Bearer access-tok',
      'chatgpt-account-id': 'acct_123',
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
    });
    expect(typeof requestHeaders?.session_id).toBe('string');
    // The Codex backend rejects store:true and requires stream:true.
    expect(requestBody).toMatchObject({ model: 'gpt-5-codex', store: false, stream: true });
    expect(requestBody).not.toHaveProperty('max_output_tokens');
    // Without thinking, no reasoning param and no raw think key (default flow).
    expect(requestBody).not.toHaveProperty('reasoning');
    expect(requestBody).not.toHaveProperty('think');
  });

  it('translates legacy ChatGPT think=true into neutral Responses reasoning and drops the raw key', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([{ type: 'response.completed' }]);
    }));
    const provider = new MarifoldOpenAICompatProvider('https://chatgpt.com/backend-api/codex', 'tok', { providerName: 'chatgpt', accountId: 'a' });
    await provider.complete([{ role: 'user', content: 'Hi' }], {
      provider: 'chatgpt', model: 'gpt-5-codex', providerOptions: { think: true },
    });
    expect(requestBody).toHaveProperty('reasoning', { effort: 'high' });
    expect(requestBody).not.toHaveProperty('think'); // raw flag never reaches the backend
  });

  it('preserves safe reasoning summaries, usage subsets, and opaque tool continuation', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              summary: [{ type: 'summary_text', text: 'Checked safely.' }],
              encrypted_content: 'opaque',
            },
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":"42"}' },
          ],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      }), { status: 200 });
    }));

    const provider = new MarifoldOpenAICompatProvider('https://api.githubcopilot.com', 'tid=test', {
      providerName: 'github_copilot',
    });
    const first = await provider.complete([{ role: 'user', content: 'Find 42.' }], {
      provider: 'github_copilot',
      model: 'gpt-5.4-mini',
      reasoning: { enabled: true, effort: 'high', summary: 'auto' },
    }, undefined, {
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    });

    expect(first).toMatchObject({
      cachedInputTokens: 4,
      reasoningTokens: 3,
      reasoning: {
        summary: 'Checked safely.',
        continuation: [{ format: 'openai.responses.reasoning.v1' }],
      },
    });

    await provider.complete([
      { role: 'user', content: 'Find 42.' },
      { role: 'assistant', content: '', toolCalls: first.toolCalls, reasoning: first.reasoning },
      { role: 'tool', content: 'found', toolCallId: 'call_1', name: 'lookup' },
    ], {
      provider: 'github_copilot',
      model: 'gpt-5.4-mini',
    });

    expect(bodies[1].input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Find 42.' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Checked safely.' }],
        encrypted_content: 'opaque',
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":"42"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ]);
  });
});

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
