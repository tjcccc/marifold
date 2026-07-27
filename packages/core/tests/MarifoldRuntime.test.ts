import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime, SessionResolver } from '../src';
import { MarifoldConfig } from '../src/config/ConfigSchema';

const tempDirs: string[] = [];
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MarifoldRuntime', () => {
  it('delegates ask to @priest-ai/core and persists SQLite sessions', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse(['hello ', 'world']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      runtime.rememberMemory('default', 'user', "The user's editor is Neovim.", 'test-session');
      const response = await runtime.ask({
        prompt: 'Which editor do I like?',
        sessionId: 'test-session',
        images: [{ data: TINY_PNG, mediaType: 'image/png' }],
        originalImages: true,
      });

      expect(response.ok).toBe(true);
      expect(response.text).toBe('hello world');
      expect(requestBody?.messages?.[0]?.content).toContain('## Memory');
      expect(requestBody?.messages?.[0]?.content).toContain("## Important User Memory");
      expect(requestBody?.messages?.[0]?.content).toContain("The user's editor is Neovim.");
      expect((requestBody as Record<string, unknown>)?.think).toBe(false);
      expect(runtime.listSessions()).toMatchObject([
        {
          id: 'test-session',
          profileName: 'default',
          turnCount: 2,
        },
      ]);
      expect(runtime.getSession('test-session')?.turns[0]?.attachments).toEqual([
        {
          kind: 'image',
          mediaType: 'image/png',
          ref: { userTurnIndex: 0, attachmentIndex: 0 },
        },
      ]);
      expect(runtime.getSession('test-session')?.turns[1]?.responseMetrics).toMatchObject({
        mode: 'chat',
        provider: 'ollama',
        model: 'gemma4:e4b',
        think: false,
        latencyMs: expect.any(Number),
      });
      expect(runtime.getSessionAttachment('test-session', 0, 0)).toEqual({
        mediaType: 'image/png',
        data: TINY_PNG,
      });
    } finally {
      runtime.close();
    }
  });

  it('regenerates one historical exchange with prefix-only context and preserves the suffix', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
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
    };
    const sessions = new SessionResolver(config.paths.sessionsDb);
    await sessions.appendExchange('edit-session', 'default', 'Conversation 1', 'Answer 1');
    await sessions.appendExchange('edit-session', 'default', 'Conversation 2', 'Answer 2');
    await sessions.appendExchange('edit-session', 'default', 'Conversation 3', 'Answer 3');
    sessions.close();

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse(['Updated answer 2']);
    }));
    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      const response = await runtime.ask({
        prompt: 'Updated conversation 2',
        sessionId: 'edit-session',
        replaceUserTurnIndex: 1,
      });
      expect(response.ok).toBe(true);
      const modelInput = JSON.stringify(requestBody?.messages ?? []);
      expect(modelInput).toContain('Conversation 1');
      expect(modelInput).not.toContain('Conversation 3');
      expect(runtime.getSession('edit-session')?.turns.map(turn => turn.content)).toEqual([
        'Conversation 1',
        'Answer 1',
        'Updated conversation 2',
        'Updated answer 2',
        'Conversation 3',
        'Answer 3',
      ]);
      expect(runtime.getSession('edit-session')?.turns[3]?.responseMetrics).toMatchObject({
        mode: 'chat',
        provider: 'ollama',
        model: 'gemma4:e4b',
        latencyMs: expect.any(Number),
      });
    } finally {
      runtime.close();
    }
  });

  it('applies model-driven memory saves and cleans hidden blocks from ask output and sessions', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse([
        '<memory_save>{"memories":[{"kind":"user","text":"The user\'s name is Jack.","priority":0,"confidence":1,"stability":"stable","source":"user_direct","conflict_key":"user.name"}]}</memory_save>',
        'Hello, Jack.',
      ]);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      const response = await runtime.ask({
        prompt: 'my name is jack',
        sessionId: 'memory-session',
      });

      expect(response.ok).toBe(true);
      expect(response.text).toBe('Hello, Jack.');
      expect(requestBody?.messages?.[0]?.content).toContain('Memory policy for Marifold');
      expect(runtime.getSession('memory-session')?.turns.at(-1)?.content).toBe('Hello, Jack.');
      expect(runtime.getSession('memory-session')?.turns.at(-1)?.content).not.toContain('memory_save');
      expect(readMemoryRows(config.paths.profilesDir, 'default', 'user.jsonl')).toMatchObject([
        {
          text: "The user's name is Jack.",
          status: 'active',
          conflict_key: 'user.name',
        },
      ]);
    } finally {
      runtime.close();
    }
  });

  it('applies prompt memory fallback when the model does not emit a save block', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn(async () => ollamaStreamResponse(['Nice to meet you.'])));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      await runtime.ask({
        prompt: 'my name is jack',
        sessionId: 'fallback-session',
      });

      expect(readMemoryRows(config.paths.profilesDir, 'default', 'user.jsonl')).toMatchObject([
        {
          text: "The user's name is Jack.",
          source: 'user_direct',
          conflict_key: 'user.name',
        },
      ]);
    } finally {
      runtime.close();
    }
  });

  it('skips profile memory when disabled for a run', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse(['ok']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      runtime.rememberMemory('default', 'user', "The user's editor is Neovim.");
      const response = await runtime.ask({
        prompt: 'Hello',
        memories: false,
      });

      expect(response.ok).toBe(true);
      expect(requestBody?.messages?.[0]?.content).not.toContain('## Memory');
      expect(requestBody?.messages?.[0]?.content).not.toContain('Neovim');
    } finally {
      runtime.close();
    }
  });

  it('passes thinking mode to supported providers', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ollamaStreamResponse(['ok']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      const response = await runtime.ask({
        prompt: 'Hello',
        think: true,
      });

      expect(response.ok).toBe(true);
      expect(requestBody?.think).toBe('high');
    } finally {
      runtime.close();
    }
  });

  it('replays only the last N session turns when a profile sets session_context_turns', async () => {
    const dir = tempDir();
    const profilesDir = path.join(dir, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'windowed'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'windowed', 'profile.toml'), 'session_context_turns = 2\n');

    const config: MarifoldConfig = {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: { profilesDir, sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    };

    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse(['ok']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    });

    try {
      for (const prompt of ['alpha', 'bravo']) {
        await runtime.ask({ prompt, sessionId: 'win', profile: 'windowed', memories: false });
      }
      // Third turn: prior turns = [alpha, ok, bravo, ok]; window of 2 keeps only [bravo, ok].
      await runtime.ask({ prompt: 'charlie', sessionId: 'win', profile: 'windowed', memories: false });

      const messages = requestBody?.messages ?? [];
      // Replayed history = all non-system messages except the current user turn.
      const replayed = messages.filter(m => m.role !== 'system').slice(0, -1);
      expect(replayed).toHaveLength(2); // window of 2, not the full 4 prior turns
      const allContent = messages.map(m => m.content).join('\n');
      expect(allContent).not.toContain('alpha'); // oldest turn dropped from the request
      expect(allContent).toContain('bravo');     // within the window
      expect(messages.at(-1)?.content).toBe('charlie');
    } finally {
      runtime.close();
    }
  });

  it('merges per-profile [agent] over the global agent config (profile wins, rest inherits)', () => {
    const dir = tempDir();
    const profilesDir = path.join(dir, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'helper'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'helper', 'profile.toml'), 'agent.approval.shell = "allow"\nagent.max_iterations = 3\nagent.trusted_folders = ["/tmp/blog"]\n');
    fs.mkdirSync(path.join(profilesDir, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'plain', 'profile.toml'), 'memories = true\n');

    const config: MarifoldConfig = {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: { profilesDir, sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
      // Global [agent]: shell asks, custom maxIterations.
      agent: { approval: { read: 'allow', write: 'ask', shell: 'ask', network: 'ask', delegate: 'allow' }, trustedFolders: ['/tmp/global'], maxIterations: 9, toolOutputLimit: 100000, toolMode: 'auto' },
    };
    const runtime = new MarifoldRuntime({
      loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    });

    try {
      const helper = runtime.resolveAgentConfigForProfile('helper');
      expect(helper.approval.shell).toBe('allow'); // profile override wins
      expect(helper.approval.write).toBe('ask');    // inherited from global
      expect(helper.maxIterations).toBe(3);          // profile override
      expect(helper.trustedFolders).toEqual(['/tmp/global', '/tmp/blog']); // union: global + profile

      const plain = runtime.resolveAgentConfigForProfile('plain');
      expect(plain.approval.shell).toBe('ask');      // global (no override)
      expect(plain.maxIterations).toBe(9);
      expect(plain.trustedFolders).toEqual(['/tmp/global']); // global only
    } finally {
      runtime.close();
    }
  });

  it('resolves think with request > profile > default precedence (default off)', () => {
    const dir = tempDir();
    const profilesDir = path.join(dir, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'thinker'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'thinker', 'profile.toml'), 'think = true\n');
    fs.mkdirSync(path.join(profilesDir, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'plain', 'profile.toml'), 'memories = true\n');

    const config: MarifoldConfig = {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: { profilesDir, sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    };
    const runtime = new MarifoldRuntime({
      loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    });

    try {
      // Profile override wins over the (off) global default.
      expect(runtime.resolveSettings({ profile: 'thinker' }).think).toBe(true);
      // An explicit request value wins over the profile override.
      expect(runtime.resolveSettings({ profile: 'thinker', think: false }).think).toBe(false);
      // Unset profile falls back to default.think (off) — no profile edits needed.
      expect(runtime.resolveSettings({ profile: 'plain' }).think).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it('refreshes expired GitHub Copilot credentials from the saved OAuth token before a run', async () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    const config: MarifoldConfig = {
      default: {
        provider: 'github_copilot',
        model: 'gpt-5.4',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['github_copilot/gpt-5.4'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        github_copilot: {
          type: 'openai-compatible',
          baseUrl: 'https://api.githubcopilot.com',
          apiKey: 'tid=expired',
          oauthToken: 'gho-refresh',
          apiKeyExpiresAt: 1,
        },
      },
    };

    let chatAuthorization: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        return new Response(JSON.stringify({
          token: 'tid=fresh',
          endpoints: { api: 'https://api.githubcopilot.com' },
          expires_at: 1893456000,
        }), { status: 200 });
      }
      if (url === 'https://api.githubcopilot.com/chat/completions') {
        chatAuthorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath,
        foundConfig: true,
      },
    });

    try {
      const response = await runtime.ask({ prompt: 'Hello' });

      expect(response.ok).toBe(true);
      expect(response.text).toBe('hello');
      expect(chatAuthorization).toBe('Bearer tid=fresh');
      const saved = fs.readFileSync(configPath, 'utf-8');
      expect(saved).toContain('api_key = "tid=fresh"');
      expect(saved).toContain('api_key_expires_at = 1893456000');
    } finally {
      runtime.close();
    }
  });

  it('uses the Responses API for GitHub Copilot responses-only models', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: {
        provider: 'github_copilot',
        model: 'gpt-5.4-mini',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['github_copilot/gpt-5.4-mini'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: {
        github_copilot: {
          type: 'openai-compatible',
          baseUrl: 'https://api.githubcopilot.com',
          apiKey: 'tid=fresh',
        },
      },
    };
    let requestUrl: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'hello from responses' }],
        }],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new MarifoldRuntime({
      loadedConfig: {
        config,
        configPath: path.join(dir, 'config.toml'),
        foundConfig: true,
      },
    });

    try {
      const response = await runtime.ask({ prompt: 'Hello' });

      expect(response.ok).toBe(true);
      expect(response.text).toBe('hello from responses');
      expect(requestUrl).toBe('https://api.githubcopilot.com/responses');
      expect(requestBody?.model).toBe('gpt-5.4-mini');
      expect(requestBody?.stream).toBe(false);
      expect(requestBody?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([{ type: 'input_text', text: 'Hello' }]),
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it('forwards the run signal to the provider so a cancel aborts the in-flight stream', async () => {
    const dir = tempDir();
    const config: MarifoldConfig = {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    };

    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return ollamaStreamingResponse(['hello ', 'world']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    });

    try {
      const controller = new AbortController();
      const stream = runtime.stream({ prompt: 'hi', signal: controller.signal });
      // Consume the first chunk so fetch has been issued with our signal wired in.
      const first = await stream.next();
      expect(first.value).toBe('hello ');
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      // Cancelling the run aborts the provider's in-flight request.
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
      await stream.return(undefined);
    } finally {
      runtime.close();
    }
  });

  it('injects the path-aware skill-manager guide for skill-related agent objectives', async () => {
    const dir = tempDir();
    const profilesDir = path.join(dir, 'profiles');
    const skillsDir = path.join(dir, 'shared-skills');
    fs.mkdirSync(path.join(profilesDir, 'writer'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'writer', 'PROFILE.md'), 'You are a writer.');
    const config: MarifoldConfig = {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'writer', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: {
        profilesDir,
        skillsDir,
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
      },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    };
    let requestBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return ollamaStreamResponse(['Done.']);
    }));

    const runtime = new MarifoldRuntime({
      loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true },
    });

    try {
      const runner = runtime.createAgentRunner('writer');
      for await (const _event of runner.run({ objective: 'Update my skills', profile: 'writer' })) {
        // Consume the run so the provider request completes.
      }
      const system = requestBody?.messages?.find(message => message.role === 'system')?.content ?? '';
      expect(system).toContain('Internal $skill-manager guide');
      expect(system).toContain(path.join(profilesDir, 'writer', 'skills'));
      expect(system).toContain(skillsDir);
    } finally {
      runtime.close();
    }
  });
});

// ask() uses the SDK's non-streaming complete() since @priest-ai/core 2.4,
// so the fake returns one Ollama JSON object rather than NDJSON chunks.
function ollamaStreamResponse(chunks: string[]): Response {
  const body = JSON.stringify({
    message: { content: chunks.join('') },
    done: true,
    done_reason: 'stop',
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Streaming NDJSON body for runtime.stream() — one Ollama chunk object per line,
// terminated by a `done` marker.
function ollamaStreamingResponse(chunks: string[]): Response {
  const lines = [
    ...chunks.map(content => JSON.stringify({ message: { content }, done: false })),
    JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function readMemoryRows(profilesDir: string, profile: string, fileName: string): Array<Record<string, unknown>> {
  const filePath = path.join(profilesDir, profile, 'memories', fileName);
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);
}
