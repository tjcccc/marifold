import { describe, expect, it } from 'vitest';
import { respond } from '../src/channels/respond';
import type { MarifoldRuntime } from '../src';

function chatRuntime(chunks: string[]): MarifoldRuntime {
  return {
    stream: async function* () { for (const c of chunks) yield c; },
  } as unknown as MarifoldRuntime;
}

function agentRuntime(events: unknown[]): MarifoldRuntime {
  return {
    createAgentRunner: () => ({ run: async function* () { for (const e of events) yield e; } }),
  } as unknown as MarifoldRuntime;
}

describe('respond', () => {
  it('chat mode accumulates stream chunks into the reply', async () => {
    const result = await respond(chatRuntime(['Hel', 'lo ', 'world']), {
      profile: 'p', mode: 'chat', prompt: 'hi', sessionId: 's',
    });
    expect(result).toEqual({ text: 'Hello world', ok: true, denied: [] });
  });

  it('agent mode accumulates text events and reports denied tools by name', async () => {
    const events = [
      { type: 'tool_request', call: { id: 'c0', tool: 'shell_exec', kind: 'shell', input: {}, summary: 'run ls' } },
      { type: 'approval_decision', requestId: 'c0', approved: false, source: 'policy', reason: 'shell denied' },
      { type: 'text', text: 'I could not run the command, ' },
      { type: 'text', text: 'but here is the answer.' },
      { type: 'done', taskId: 't', status: 'completed' },
    ];
    const result = await respond(agentRuntime(events), {
      profile: 'p', mode: 'agent', prompt: 'do it', sessionId: 's',
    });
    expect(result.text).toBe('I could not run the command, but here is the answer.');
    expect(result.denied).toEqual(['shell_exec']);
    expect(result.ok).toBe(true);
  });

  it('agent mode with no denials returns ok with an empty denied list', async () => {
    const events = [
      { type: 'text', text: 'Done.' },
      { type: 'done', taskId: 't', status: 'completed' },
    ];
    const result = await respond(agentRuntime(events), {
      profile: 'p', mode: 'agent', prompt: 'go', sessionId: 's',
    });
    expect(result).toEqual({ text: 'Done.', ok: true, denied: [] });
  });

  it('agent mode flags ok=false when the run does not complete', async () => {
    const events = [
      { type: 'text', text: 'partial…' },
      { type: 'done', taskId: 't', status: 'failed' },
    ];
    const result = await respond(agentRuntime(events), {
      profile: 'p', mode: 'agent', prompt: 'go', sessionId: 's',
    });
    expect(result.ok).toBe(false); // bridge can say "the run failed" instead of sending a half-reply
  });
});
