import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime } from '../src';
import { MarifoldConfig } from '../src/config/ConfigSchema';
import { formatSearchContext, formatSearchResults, SearchBackend } from '../src/search/SearchBackend';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-parity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function baseConfig(dir: string, overrides: Partial<MarifoldConfig> = {}): MarifoldConfig {
  return {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: {
      profilesDir: path.join(dir, 'profiles'),
      sessionsDb: path.join(dir, 'sessions.db'),
      tasksDir: path.join(dir, 'tasks'),
    },
    providers: {
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    },
    ...overrides,
  };
}

function runtimeFor(dir: string, config: MarifoldConfig, searchBackend?: SearchBackend): MarifoldRuntime {
  return new MarifoldRuntime({
    loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    searchBackend,
  });
}

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map(chunk => JSON.stringify(chunk)).join('\n') + '\n';
  return new Response(body, { status: 200 });
}

function ollamaJsonResponse(text: string): Response {
  return new Response(JSON.stringify({ message: { content: text }, done: true, done_reason: 'stop' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function responsesSse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collectStream(stream: AsyncGenerator<string>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return parts.join('');
}

describe('search formatting', () => {
  it('formats numbered results and the turn-local context wrapper', () => {
    const block = formatSearchResults('weather', [
      { title: 'Forecast', url: 'https://x/y', snippet: 'Sunny.' },
    ]);
    expect(block).toContain('## Web search results for: weather');
    expect(block).toContain('1. **Forecast**');
    expect(formatSearchContext(block)).toContain('Do not request another web search');
    expect(formatSearchResults('nothing', [])).toContain('returned no results');
  });
});

describe('chat tool loop', () => {
  it('surfaces provider failures instead of completing with a blank response', async () => {
    const dir = tempDir();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));

    const runtime = runtimeFor(dir, baseConfig(dir));
    try {
      await expect(collectStream(runtime.stream({
        prompt: 'Hello',
        sessionId: 'failed-new-session',
        memories: false,
      })))
        .rejects.toMatchObject({
          code: 'PROVIDER_ERROR',
          message: expect.stringContaining('HTTP 429'),
          details: {
            provider: 'ollama',
            model: 'gemma4:e4b',
            upstreamCode: 'PROVIDER_ERROR',
          },
        });
      expect(runtime.getSession('failed-new-session')).toBeUndefined();
    } finally {
      runtime.close();
    }
  });

  it('surfaces a successful provider completion that contains no answer text', async () => {
    const dir = tempDir();
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      { message: { content: '' }, done: true, done_reason: 'stop' },
    ])));

    const runtime = runtimeFor(dir, baseConfig(dir));
    try {
      await expect(collectStream(runtime.stream({
        prompt: 'Hello',
        sessionId: 'empty-new-session',
        memories: false,
      })))
        .rejects.toMatchObject({
          code: 'PROVIDER_ERROR',
          message: "Provider 'ollama' returned no text for model 'gemma4:e4b'.",
          details: {
            provider: 'ollama',
            model: 'gemma4:e4b',
            upstreamCode: 'EMPTY_RESPONSE',
          },
        });
      expect(runtime.getSession('empty-new-session')).toBeUndefined();
    } finally {
      runtime.close();
    }
  });

  it('replays Responses session assistant turns as output_text', async () => {
    const dir = tempDir();
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      const text = call === 1 ? 'First answer.' : 'Second answer.';
      return responsesSse([
        { type: 'response.output_text.delta', delta: text },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              content: [{ type: 'output_text', text }],
            }],
          },
        },
      ]);
    }));

    const config = baseConfig(dir, {
      default: {
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        profile: 'default',
        think: true,
      },
      models: { options: ['chatgpt/gpt-5.6-sol'] },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          apiKey: 'test-access-token',
        },
      },
    });
    const runtime = runtimeFor(dir, config);
    try {
      expect(await collectStream(runtime.stream({
        prompt: 'First question.',
        sessionId: 'responses-history',
        memories: false,
      }))).toBe('First answer.');
      expect(await collectStream(runtime.stream({
        prompt: 'Second question.',
        sessionId: 'responses-history',
        memories: false,
      }))).toBe('Second answer.');

      expect(bodies[1].input).toEqual(expect.arrayContaining([{
        role: 'assistant',
        content: [{ type: 'output_text', text: 'First answer.' }],
      }]));
      expect(JSON.stringify(bodies[1].input)).not.toContain(
        '"role":"assistant","content":[{"type":"input_text"',
      );
    } finally {
      runtime.close();
    }
  });

  it('executes model-initiated web_search and streams the final answer', async () => {
    const dir = tempDir();
    const queries: string[] = [];
    const backend: SearchBackend = {
      search: async query => {
        queries.push(query);
        return [{ title: 'Result', url: 'https://example.com', snippet: 'Useful fact.' }];
      },
    };

    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return ndjsonResponse([
          { message: { content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'marifold news' } } }] } },
          { message: { content: '' }, done: true, done_reason: 'stop' },
        ]);
      }
      return ndjsonResponse([
        { message: { content: 'Here is what I found.' } },
        { message: { content: '' }, done: true, done_reason: 'stop' },
      ]);
    }));

    const runtime = runtimeFor(dir, baseConfig(dir, { webSearch: { enabled: true, maxResults: 3 } }), backend);
    try {
      const text = await collectStream(runtime.stream({ prompt: 'Any marifold news?', memories: false }));
      expect(text).toBe('Here is what I found.');
      expect(queries).toEqual(['marifold news']);

      // First request advertised tools; second replayed the tool result.
      expect(bodies[0].tools).toBeDefined();
      const replayMessages = bodies[1].messages as Array<Record<string, unknown>>;
      const toolMessage = replayMessages.find(m => m.role === 'tool');
      expect(toolMessage?.tool_name).toBe('web_search');
      expect(String(toolMessage?.content)).toContain('Useful fact.');
    } finally {
      runtime.close();
    }
  });

  it('executes the Marifold fallback in the non-streaming ask path', async () => {
    const dir = tempDir();
    const queries: string[] = [];
    const backend: SearchBackend = {
      search: async query => {
        queries.push(query);
        return [{ title: 'Result', url: 'https://example.com', snippet: 'Fresh fact.' }];
      },
    };
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          message: {
            content: '',
            tool_calls: [{
              function: { name: 'web_search', arguments: { query: 'marifold current' } },
            }],
          },
          done: true,
          done_reason: 'stop',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return ollamaJsonResponse('Here is the current answer.');
    }));

    const runtime = runtimeFor(dir, baseConfig(dir, {
      webSearch: { enabled: true, provider: 'duckduckgo', maxResults: 3 },
    }), backend);
    try {
      const response = await runtime.ask({
        prompt: 'Find current Marifold information.',
        memories: false,
      });
      expect(response.ok).toBe(true);
      expect(response.text).toBe('Here is the current answer.');
      expect(queries).toEqual(['marifold current']);
      expect(bodies[0].tools).toBeDefined();
      expect(JSON.stringify(bodies[1].messages)).toContain('Fresh fact.');
    } finally {
      runtime.close();
    }
  });

  it('does not advertise tools when web search is disabled', async () => {
    const dir = tempDir();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return ndjsonResponse([
        { message: { content: 'plain' } },
        { message: { content: '' }, done: true, done_reason: 'stop' },
      ]);
    }));

    const runtime = runtimeFor(dir, baseConfig(dir));
    try {
      const text = await collectStream(runtime.stream({ prompt: 'Hello', memories: false }));
      expect(text).toBe('plain');
      expect(bodies[0].tools).toBeUndefined();
      const messages = bodies[0].messages as Array<Record<string, unknown>>;
      expect(messages[0].content).toContain('Web search is unavailable for this run');
    } finally {
      runtime.close();
    }
  });

  it('uses ChatGPT hosted web search while the Marifold fallback is disabled', async () => {
    const dir = tempDir();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesSse([
        { type: 'response.output_text.delta', delta: 'Current answer.' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Current answer.' }] }],
          },
        },
      ]);
    }));

    const config = baseConfig(dir, {
      default: {
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        profile: 'default',
        think: false,
        maxOutputTokens: 256,
      },
      models: { options: ['chatgpt/gpt-5.6-sol'] },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          apiKey: 'test-access-token',
        },
      },
      webSearch: { enabled: false, provider: 'duckduckgo', maxResults: 5 },
    });
    const runtime = runtimeFor(dir, config);
    try {
      expect(await collectStream(runtime.stream({
        prompt: 'Search for something current.',
        memories: false,
      }))).toBe('Current answer.');
      expect(bodies[0].tools).toEqual([{ type: 'web_search' }]);
      expect(bodies[0]).not.toHaveProperty('max_output_tokens');
      expect(JSON.stringify(bodies[0].input)).toContain('Provider-hosted web search is available');
    } finally {
      runtime.close();
    }
  });

  it('prefers hosted search over the configured fallback without dropping unrelated chat tools', async () => {
    const dir = tempDir();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesSse([
        { type: 'response.output_text.delta', delta: 'Done.' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }],
          },
        },
      ]);
    }));

    const config = baseConfig(dir, {
      default: { provider: 'chatgpt', model: 'gpt-5.6-sol', profile: 'default', think: false },
      models: { options: ['chatgpt/gpt-5.6-sol'] },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          apiKey: 'test-access-token',
        },
      },
      webSearch: { enabled: true, provider: 'duckduckgo', maxResults: 5 },
    });
    const runtime = runtimeFor(dir, config);
    try {
      expect(await collectStream(runtime.stream({ prompt: 'Search the web.', memories: false }))).toBe('Done.');
      expect(bodies[0].tools).toEqual([
        { type: 'web_search' },
        expect.objectContaining({ type: 'function', name: 'read_file' }),
      ]);
      expect(JSON.stringify(bodies[0].tools)).not.toContain('"name":"web_search"');
    } finally {
      runtime.close();
    }
  });

  it('replays opaque Responses reasoning through the chat tool loop and surfaces only the safe summary', async () => {
    const dir = tempDir();
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return responsesSse([
          { type: 'response.reasoning_summary_text.delta', delta: 'Checking sources.' },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '' },
          },
          {
            type: 'response.function_call_arguments.done',
            output_index: 1,
            name: 'web_search',
            arguments: '{"query":"marifold news"}',
          },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_1',
                  summary: [{ type: 'summary_text', text: 'Checking sources.' }],
                  encrypted_content: 'opaque',
                },
                {
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'web_search',
                  arguments: '{"query":"marifold news"}',
                },
              ],
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens: 7,
                output_tokens_details: { reasoning_tokens: 3 },
              },
            },
          },
        ]);
      }
      return responsesSse([
        { type: 'response.output_text.delta', delta: 'Here is what I found.' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              content: [{ type: 'output_text', text: 'Here is what I found.' }],
            }],
            usage: { input_tokens: 20, output_tokens: 4 },
          },
        },
      ]);
    }));

    const config = baseConfig(dir, {
      default: {
        provider: 'github_copilot',
        model: 'gpt-5.4-mini',
        profile: 'default',
        think: true,
      },
      models: { options: ['github_copilot/gpt-5.4-mini'] },
      providers: {
        github_copilot: {
          type: 'openai-compatible',
          baseUrl: 'https://api.githubcopilot.com',
          apiKey: 'tid=test',
        },
      },
      webSearch: { enabled: true, maxResults: 3 },
    });
    const backend: SearchBackend = {
      search: async () => [{ title: 'Result', url: 'https://example.com', snippet: 'Useful fact.' }],
    };
    const runtime = runtimeFor(dir, config, backend);
    const summaries: string[] = [];
    let usage: { reasoningTokens?: number; cachedInputTokens?: number } | undefined;
    try {
      const text = await collectStream(runtime.stream(
        { prompt: 'Any marifold news?', memories: false },
        result => { usage = result.usage; },
        summary => summaries.push(summary),
      ));

      expect(text).toBe('Here is what I found.');
      expect(summaries.join('')).toBe('Checking sources.');
      expect(usage).toMatchObject({ cachedInputTokens: 4, reasoningTokens: 3 });
      expect(bodies[0]).toMatchObject({
        reasoning: { effort: 'high', summary: 'auto' },
      });
      const replay = bodies[1].input as Array<Record<string, unknown>>;
      expect(replay).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'opaque',
        }),
        expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      ]));
      expect(JSON.stringify(replay)).not.toContain('private');
    } finally {
      runtime.close();
    }
  });

  it('searchWeb formats backend results for the /search command', async () => {
    const dir = tempDir();
    const backend: SearchBackend = {
      search: async () => [{ title: 'T', url: 'https://u', snippet: 'S' }],
    };
    const runtime = runtimeFor(dir, baseConfig(dir), backend);
    try {
      const block = await runtime.searchWeb('anything');
      expect(block).toContain('1. **T**');
    } finally {
      runtime.close();
    }
  });
});

describe('image plumbing', () => {
  it('passes base64 images through to the provider request', async () => {
    const dir = tempDir();
    let body: { messages?: Array<{ role: string; images?: string[] }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return ollamaJsonResponse('I see a cat.');
    }));

    const runtime = runtimeFor(dir, baseConfig(dir));
    try {
      const response = await runtime.ask({
        prompt: 'What is in this image?',
        memories: false,
        images: [{ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', mediaType: 'image/png' }],
      });
      expect(response.ok).toBe(true);
      const userMessage = body?.messages?.find(m => m.role === 'user');
      expect(userMessage?.images).toEqual(['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=']);
    } finally {
      runtime.close();
    }
  });
});

describe('ChatGPT credential refresh', () => {
  it('refreshes an expired chatgpt credential before the provider call and persists it', async () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '');
    const config = baseConfig(dir, {
      default: { provider: 'chatgpt', model: 'gpt-4o-mini', profile: 'default', think: false },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://api.openai.com',
          apiKey: 'expired-key',
          oauthToken: 'refresh-token-1',
          apiKeyExpiresAt: Math.floor(Date.now() / 1000) - 10,
        },
      },
    });

    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://auth.openai.com/oauth/token')) {
        const raw = init?.body;
        const isRefresh = typeof raw === 'string' && raw.includes('refresh_token');
        if (isRefresh) {
          return new Response(JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'refresh-token-2',
            id_token: 'id-token',
            expires_in: 3600,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ access_token: 'fresh-api-key' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath, foundConfig: true } });
    try {
      const response = await runtime.ask({ prompt: 'Hi', memories: false });
      expect(response.ok).toBe(true);
      // Subscription mode: the refreshed access token is the credential — no
      // id_token→API-key exchange, so only the single refresh call is made.
      expect(config.providers.chatgpt.apiKey).toBe('new-access');
      expect(config.providers.chatgpt.oauthToken).toBe('refresh-token-2');
      expect(config.providers.chatgpt.apiKeyExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(urls.filter(u => u.includes('auth.openai.com'))).toHaveLength(1);
      expect(fs.readFileSync(configPath, 'utf-8')).toContain('new-access');
    } finally {
      runtime.close();
    }
  });

  it('does not refresh when the credential is still valid', async () => {
    const dir = tempDir();
    const config = baseConfig(dir, {
      default: { provider: 'chatgpt', model: 'gpt-4o-mini', profile: 'default', think: false },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://api.openai.com',
          apiKey: 'valid-key',
          oauthToken: 'refresh-token-1',
          apiKeyExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    });

    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const runtime = runtimeFor(dir, config);
    try {
      await runtime.ask({ prompt: 'Hi', memories: false });
      expect(urls.every(url => !url.includes('auth.openai.com'))).toBe(true);
    } finally {
      runtime.close();
    }
  });
});
