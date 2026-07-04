import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoadedMarifoldConfig, MarifoldConfig } from '@marifold/core';

const tempDirs: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-service-'));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal loaded config over a temp dir: one ollama provider (its apiKey is
 * the sanitization canary) and all state paths inside `dir`. `overrides` merge
 * at the top level, e.g. `{ service: {...}, agent: {...} }`. */
export function fixtureLoadedConfig(dir: string, overrides: Partial<MarifoldConfig> = {}): LoadedMarifoldConfig {
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
      schedulesDir: path.join(dir, 'schedules'),
    },
    providers: {
      ollama: {
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: 'test-secret-key',
      },
    },
    ...overrides,
  };
  return {
    config,
    configPath: path.join(dir, 'config.toml'),
    foundConfig: true,
  };
}

// /v1/ask uses the SDK's non-streaming complete() since @priest-ai/core 2.4,
// so the fake returns one Ollama JSON object rather than NDJSON chunks.
export function ollamaStreamResponse(chunks: string[]): Response {
  const body = JSON.stringify({
    message: { content: chunks.join('') },
    done: true,
    done_reason: 'stop',
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
