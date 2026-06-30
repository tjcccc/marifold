import { describe, expect, it } from 'vitest';
import { TelegramBridge } from '../src/channels/TelegramBridge';
import type { MarifoldRuntime } from '../src';
import type { ProfileMode, TelegramChannelConfig } from '../src/config/ConfigSchema';

interface Sent { chatId: number; text: string }

function makeBridge(opts: {
  allowlist?: number[];
  defaultMode?: ProfileMode;
  chatChunks?: string[];
  agentEvents?: unknown[];
} = {}): { bridge: TelegramBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).includes('/sendMessage')) {
      sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const runtime = {
    stream: async function* () { for (const c of (opts.chatChunks ?? ['hello'])) yield c; },
    createAgentRunner: () => ({
      run: async function* () {
        for (const e of (opts.agentEvents ?? [{ type: 'text', text: 'agent reply' }, { type: 'done', status: 'completed' }])) yield e;
      },
    }),
  } as unknown as MarifoldRuntime;

  const config: TelegramChannelConfig = {
    allowlist: opts.allowlist ?? [42],
    profile: 'messenger',
    defaultMode: opts.defaultMode ?? 'chat',
  };
  return { bridge: new TelegramBridge({ runtime, token: 'TKN', config, fetchImpl }), sent };
}

function msg(text: string, fromId = 42, chatId = 100) {
  return { update_id: 1, message: { chat: { id: chatId }, from: { id: fromId }, text } };
}

describe('TelegramBridge.handleUpdate', () => {
  it('ignores messages from non-allowlisted senders', async () => {
    const { bridge, sent } = makeBridge({ allowlist: [42] });
    await bridge.handleUpdate(msg('hello', 999));
    expect(sent).toHaveLength(0);
  });

  it('ignores updates without text', async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 100 }, from: { id: 42 } } });
    expect(sent).toHaveLength(0);
  });

  it('runs an allowlisted chat message through respond and sends the reply', async () => {
    const { bridge, sent } = makeBridge({ defaultMode: 'chat', chatChunks: ['Hel', 'lo wor', 'ld'] });
    await bridge.handleUpdate(msg('hi'));
    expect(sent).toEqual([{ chatId: 100, text: 'Hello world' }]);
  });

  it('/help replies with usage and does not run the model', async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleUpdate(msg('/help'));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('/agent');
    expect(sent[0].text).toContain('/chat');
  });

  it('/agent switches the chat to agent mode for the next message', async () => {
    const { bridge, sent } = makeBridge({ defaultMode: 'chat', agentEvents: [{ type: 'text', text: 'agent answer' }, { type: 'done', status: 'completed' }] });
    await bridge.handleUpdate(msg('/agent'));
    expect(sent[0].text).toBe('Switched to agent mode.');
    await bridge.handleUpdate(msg('do something'));
    expect(sent[1].text).toBe('agent answer'); // came from the agent runner, not the chat stream
  });

  it('appends a note for tools the agent could not run', async () => {
    const { bridge, sent } = makeBridge({
      defaultMode: 'agent',
      agentEvents: [
        { type: 'tool_request', call: { id: 'c0', tool: 'shell_exec' } },
        { type: 'approval_decision', requestId: 'c0', approved: false },
        { type: 'text', text: 'Answered without the shell.' },
        { type: 'done', status: 'completed' },
      ],
    });
    await bridge.handleUpdate(msg('run ls'));
    expect(sent[0].text).toContain('Answered without the shell.');
    expect(sent[0].text).toContain('shell_exec');
  });

  it('splits a reply longer than Telegram’s limit into multiple messages', async () => {
    const { bridge, sent } = makeBridge({ defaultMode: 'chat', chatChunks: ['x'.repeat(5000)] });
    await bridge.handleUpdate(msg('hi'));
    expect(sent.length).toBe(2);
    expect(sent[0].text.length).toBeLessThanOrEqual(4096);
    expect((sent[0].text + sent[1].text).length).toBe(5000);
  });
});
