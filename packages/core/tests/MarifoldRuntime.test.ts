import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldRuntime } from '../src';
import { MarifoldConfig } from '../src/config/ConfigSchema';

const tempDirs: string[] = [];

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
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn(async () => ollamaStreamResponse(['hello ', 'world'])));

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
        sessionId: 'test-session',
      });

      expect(response.ok).toBe(true);
      expect(response.text).toBe('hello world');
      expect(runtime.listSessions()).toMatchObject([
        {
          id: 'test-session',
          profileName: 'default',
          turnCount: 2,
        },
      ]);
    } finally {
      runtime.close();
    }
  });
});

function ollamaStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: chunk } })}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
