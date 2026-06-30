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
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Hello' },
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
