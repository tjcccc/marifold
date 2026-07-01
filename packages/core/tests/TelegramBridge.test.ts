import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelegramBridge } from '../src/channels/TelegramBridge';
import type { MarifoldRuntime } from '../src';
import type { ProfileMode, TelegramChannelConfig } from '../src/config/ConfigSchema';

const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 });

interface Sent { chatId: number; text: string; replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }

function makeBridge(opts: {
  allowlist?: number[];
  defaultMode?: ProfileMode;
  chatChunks?: string[];
  agentEvents?: unknown[];
  runtime?: MarifoldRuntime;
} = {}): { bridge: TelegramBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  let messageId = 0;
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).includes('/sendMessage')) {
      sent.push({ chatId: body.chat_id, text: body.text, replyMarkup: body.reply_markup });
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), { status: 200 });
    }
    // getUpdates -> [], everything else (editMessageText/answerCallbackQuery) -> true.
    const result = String(url).includes('/getUpdates') ? [] : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;

  const runtime = opts.runtime ?? ({
    stream: async function* () { for (const c of (opts.chatChunks ?? ['hello'])) yield c; },
    createAgentRunner: () => ({
      run: async function* () {
        for (const e of (opts.agentEvents ?? [{ type: 'text', text: 'agent reply' }, { type: 'done', status: 'completed' }])) yield e;
      },
    }),
  } as unknown as MarifoldRuntime);

  const config: TelegramChannelConfig = {
    allowlist: opts.allowlist ?? [42],
    profile: 'messenger',
    defaultMode: opts.defaultMode ?? 'chat',
  };
  return { bridge: new TelegramBridge({ runtime, token: 'TKN', config, fetchImpl, profilesDir: '/tmp/marifold-test-profiles' }), sent };
}

function msg(text: string, fromId = 42, chatId = 100) {
  return { update_id: 1, message: { chat: { id: chatId }, from: { id: fromId }, text } };
}

function callback(data: string, fromId = 42) {
  return { update_id: 2, callback_query: { id: 'cb1', from: { id: fromId }, data } };
}

async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise(r => setTimeout(r, 5));
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

  it('prompts for approval with inline buttons and continues when the user taps Allow', async () => {
    // Agent run that calls the approvalHandler and proceeds only if approved.
    const runtime = {
      createAgentRunner: () => ({
        run: async function* (options: { approvalHandler?: (r: unknown) => Promise<{ approved: boolean }> }) {
          const decision = await options.approvalHandler!({
            id: 'a1', tool: 'web_search', kind: 'network',
            summary: 'search: 2026 world cup', input: {}, escalated: false,
          });
          if (decision.approved) yield { type: 'text', text: 'Found the score.' };
          else yield { type: 'text', text: 'Could not search.' };
          yield { type: 'done', status: 'completed' };
        },
      }),
    } as unknown as MarifoldRuntime;

    const { bridge, sent } = makeBridge({ defaultMode: 'agent', runtime });

    const turn = bridge.handleUpdate(msg('who plays tonight?')); // blocks on approval
    await waitFor(() => sent.some(s => s.replyMarkup !== undefined));

    const prompt = sent.find(s => s.replyMarkup);
    expect(prompt).toBeDefined();
    expect(prompt!.text).toContain('web_search');
    const allowData = prompt!.replyMarkup!.inline_keyboard[0][0].callback_data;
    expect(allowData).toMatch(/^appr:.+:once$/);

    await bridge.handleUpdate(callback(allowData)); // tap "Allow once"
    await turn;

    // The final reply reflects the approved run.
    expect(sent[sent.length - 1].text).toBe('Found the score.');
  });

  it('denies (and reports) when the user taps Deny', async () => {
    const runtime = {
      createAgentRunner: () => ({
        run: async function* (options: { approvalHandler?: (r: unknown) => Promise<{ approved: boolean }> }) {
          const decision = await options.approvalHandler!({
            id: 'a1', tool: 'web_search', kind: 'network', summary: 'search', input: {}, escalated: false,
          });
          if (!decision.approved) {
            yield { type: 'tool_request', call: { id: 'a1', tool: 'web_search' } };
            yield { type: 'approval_decision', requestId: 'a1', approved: false };
          }
          yield { type: 'text', text: 'Done.' };
          yield { type: 'done', status: 'completed' };
        },
      }),
    } as unknown as MarifoldRuntime;

    const { bridge, sent } = makeBridge({ defaultMode: 'agent', runtime });
    const turn = bridge.handleUpdate(msg('search please'));
    await waitFor(() => sent.some(s => s.replyMarkup !== undefined));
    const denyData = sent.find(s => s.replyMarkup)!.replyMarkup!.inline_keyboard[2][0].callback_data;
    await bridge.handleUpdate(callback(denyData));
    await turn;
    expect(sent[sent.length - 1].text).toContain('web_search'); // denial note names the tool
  });

  it('saves a received document to the inbox and offers it to the next turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mari-tg-'));
    try {
      const sentText: string[] = [];
      let capturedPrompt = '';
      const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
        const u = String(url);
        if (u.includes('/getFile')) return json({ ok: true, result: { file_path: 'documents/note.txt' } });
        if (u.includes('/file/bot')) return new Response(Buffer.from('hello file'), { status: 200 });
        if (u.includes('/sendMessage')) { sentText.push(JSON.parse(String(init?.body)).text); return json({ ok: true, result: { message_id: 1 } }); }
        return json({ ok: true, result: [] });
      }) as unknown as typeof fetch;
      const runtime = {
        createAgentRunner: () => ({
          run: async function* (o: { objective: string }) {
            capturedPrompt = o.objective;
            yield { type: 'text', text: 'ok' };
            yield { type: 'done', status: 'completed' };
          },
        }),
      } as unknown as MarifoldRuntime;
      const bridge = new TelegramBridge({
        runtime, token: 'TKN', fetchImpl, profilesDir: dir,
        config: { allowlist: [42], profile: 'messenger', defaultMode: 'agent' },
      });

      await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 100 }, from: { id: 42 }, document: { file_id: 'f1', file_name: 'note.txt' } } });
      const savedPath = join(dir, 'messenger', 'inbox', 'note.txt');
      expect(await readFile(savedPath, 'utf8')).toBe('hello file');
      expect(sentText.some(t => t.includes('inbox'))).toBe(true);

      await bridge.handleUpdate({ update_id: 2, message: { chat: { id: 100 }, from: { id: 42 }, text: 'what is it?' } });
      expect(capturedPrompt).toContain(savedPath); // the next turn is told where the file is
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers files the agent writes to the outbox and moves them to sent/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mari-tg-'));
    try {
      const uploads: string[] = [];
      const fetchImpl = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/sendDocument') || u.includes('/sendPhoto')) {
          uploads.push(u.includes('/sendPhoto') ? 'photo' : 'document');
          return json({ ok: true, result: {} });
        }
        if (u.includes('/sendMessage')) return json({ ok: true, result: { message_id: 1 } });
        return json({ ok: true, result: [] });
      }) as unknown as typeof fetch;
      const runtime = {
        createAgentRunner: () => ({
          run: async function* (o: { cwd: string }) {
            await writeFile(join(o.cwd, 'report.md'), '# hi');
            yield { type: 'text', text: 'wrote it' };
            yield { type: 'done', status: 'completed' };
          },
        }),
      } as unknown as MarifoldRuntime;
      const bridge = new TelegramBridge({
        runtime, token: 'TKN', fetchImpl, profilesDir: dir,
        config: { allowlist: [42], profile: 'messenger', defaultMode: 'agent' },
      });

      await bridge.handleUpdate({ update_id: 1, message: { chat: { id: 100 }, from: { id: 42 }, text: 'make a report' } });

      expect(uploads).toEqual(['document']);
      expect(await readdir(join(dir, 'messenger', 'outbox', 'sent'))).toContain('report.md');
      expect(await readdir(join(dir, 'messenger', 'outbox'))).not.toContain('report.md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
