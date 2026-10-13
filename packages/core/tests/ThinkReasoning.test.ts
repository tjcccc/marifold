import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMarifoldConfig } from '../src/config/ConfigSchema';
import { MarifoldOpenAICompatProvider } from '../src/config/MarifoldOpenAICompatProvider';
import { ReasoningRetryProvider } from '../src/config/ReasoningRetry';
import { ProviderEngines } from '../src/runtime/ProviderEngines';

afterEach(() => { vi.unstubAllGlobals(); });

const loaded = {
  configPath: '/tmp/config.toml',
  foundConfig: true,
  config: {
    default: { provider: 'xai', model: 'grok-4.6', profile: 'default', think: false },
    providers: {
      xai: { type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' },
      bailian: { type: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode' },
      chatgpt: { type: 'openai-compatible', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    },
  },
} as unknown as LoadedMarifoldConfig;
const engines = new ProviderEngines(loaded, {} as never, {} as never, {} as never);

function chatReply(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
}

/** Send one request the way a chat turn does and return the HTTP bodies. */
async function sentBodies(providerName: string, model: string, think: boolean, reply: (call: number) => Response = chatReply, search: 'none' | 'responses-tool' = 'none') {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply(bodies.length);
  }));
  const baseUrl = loaded.config.providers[providerName].baseUrl!;
  const provider = new ReasoningRetryProvider(new MarifoldOpenAICompatProvider(baseUrl, 'key', { providerName }), providerName);
  const config = engines.priestConfig({ profile: 'p', provider: providerName, model, think, mode: 'chat' }, search);
  await provider.complete([{ role: 'user', content: 'Hi' }], config);
  return bodies;
}

describe('global think on the wire', () => {
  it('asks Grok for medium effort when on and low when off, never its high default', async () => {
    expect((await sentBodies('xai', 'grok-4.6', true))[0]).toMatchObject({ reasoning_effort: 'medium' });
    expect((await sentBodies('xai', 'grok-4.6', false))[0]).toMatchObject({ reasoning_effort: 'low' });
  });

  it('switches Bailian thinking with enable_thinking, not a raw think key', async () => {
    const [on] = await sentBodies('bailian', 'qwen3.8-27b', true);
    const [off] = await sentBodies('bailian', 'qwen3.8-27b', false);
    expect(on).toMatchObject({ enable_thinking: true });
    expect(off).toMatchObject({ enable_thinking: false });
    expect(off).not.toHaveProperty('think');
  });

  it('keeps each dialect on the Responses API that native web search uses', async () => {
    const responsesReply = () => new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 });
    const [grok] = await sentBodies('xai', 'grok-4.6', false, responsesReply, 'responses-tool');
    expect(grok).toMatchObject({ reasoning: { effort: 'low' } });
    expect(grok.reasoning).not.toHaveProperty('summary');
    const [deepseek] = await sentBodies('bailian', 'deepseek-v4-flash', true, responsesReply, 'responses-tool');
    expect(deepseek).toMatchObject({ enable_thinking: true });
    expect(deepseek).not.toHaveProperty('reasoning');
  });

  it('sends ChatGPT low effort when off, for every model', () => {
    expect(engines.priestConfig({ profile: 'p', provider: 'chatgpt', model: 'gpt-6.1-sol', think: false, mode: 'chat' }).reasoning)
      .toEqual({ enabled: true, effort: 'low' });
    expect(engines.priestConfig({ profile: 'p', provider: 'chatgpt', model: 'gpt-6.1-sol', think: true, mode: 'chat' }).reasoning)
      .toEqual({ enabled: true, effort: 'medium', summary: 'auto' });
  });

  it('gives Ollama on/off models a plain switch and gpt-oss its levels', () => {
    const reasoning = (model: string, think: boolean) =>
      engines.priestConfig({ profile: 'p', provider: 'ollama', model, think, mode: 'chat' }).reasoning;
    // A level string makes gemma4 use its default and skip thinking, so it must get true/false.
    expect(reasoning('gemma4:31b-cloud', true)).toEqual({ enabled: true, summary: 'auto' });
    expect(reasoning('gemma4:31b-cloud', false)).toEqual({ enabled: false });
    expect(reasoning('gpt-oss:20b-cloud', false)).toEqual({ enabled: true, effort: 'low' });
  });

  it('retries once without the field when a model rejects it, then stops sending it', async () => {
    const reject = (call: number) => call === 1
      ? new Response('{"error":"Model grok-4-old does not support parameter reasoning_effort"}', { status: 400 })
      : chatReply();
    const bodies = await sentBodies('xai', 'grok-4-old', true, reject);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect((await sentBodies('xai', 'grok-4-old', true))[0]).not.toHaveProperty('reasoning_effort');
    // Other 400s, including ones about replayed reasoning items, are real errors:
    // no retry, and the model keeps its setting.
    const item = () => new Response('{"error":"Item rs_1 of type reasoning was provided without its required following item"}', { status: 400 });
    await expect(sentBodies('xai', 'grok-4.6', true, item)).rejects.toThrow(/HTTP 400/);
    expect((await sentBodies('xai', 'grok-4.6', true))[0]).toMatchObject({ reasoning_effort: 'medium' });
    await expect(sentBodies('xai', 'grok-4.7', true, () => new Response('{"error":"bad messages"}', { status: 400 })))
      .rejects.toThrow(/HTTP 400/);
  });
});
