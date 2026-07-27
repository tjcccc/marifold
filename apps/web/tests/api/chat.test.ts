import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { streamChat } from '../../src/api/chat';

describe('streamChat', () => {
  it('preserves safe reasoning summaries before answer chunks', async () => {
    const client: ApiClient = {
      baseUrl: '',
      request: async () => {
        throw new Error('unexpected request');
      },
      stream: async () => new Response([
        'event: reasoning\ndata: {"text":"Checked the constraints."}\n\n',
        'event: chunk\ndata: {"text":"Answer"}\n\n',
        'event: done\ndata: {"latencyMs":2250,"usage":{"inputTokens":120,"outputTokens":30,"totalTokens":150}}\n\n',
      ].join(''), { status: 200 }),
      blob: async () => undefined,
    };

    const events = [];
    for await (const event of streamChat(client, { prompt: 'Question' })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'reasoning', text: 'Checked the constraints.' },
      { type: 'chunk', text: 'Answer' },
      {
        type: 'done',
        latencyMs: 2250,
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    ]);
  });
});
