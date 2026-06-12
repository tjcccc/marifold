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
        images: [{ data: 'BASE64CAT', mediaType: 'image/png' }],
      });
      expect(response.ok).toBe(true);
      const userMessage = body?.messages?.find(m => m.role === 'user');
      expect(userMessage?.images).toEqual(['BASE64CAT']);
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
      expect(config.providers.chatgpt.apiKey).toBe('fresh-api-key');
      expect(config.providers.chatgpt.oauthToken).toBe('refresh-token-2');
      expect(config.providers.chatgpt.apiKeyExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(urls.filter(u => u.includes('auth.openai.com'))).toHaveLength(2);
      expect(fs.readFileSync(configPath, 'utf-8')).toContain('fresh-api-key');
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
