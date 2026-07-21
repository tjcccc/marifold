import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PriestRequest, PriestResponse } from '@priest-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEngine, AgentRunner } from '../src/agent/AgentRunner';
import { AgentEvent } from '../src/agent/AgentEvents';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { AgentTool, ToolRegistry } from '../src/agent/ToolRegistry';
import { WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { TaskStore } from '../src/tasks/TaskStore';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function response(partial: Partial<PriestResponse>): PriestResponse {
  return {
    text: '',
    execution: { provider: 'mock', model: 'test-model', profile: 'default' },
    metadata: {},
    ok: true,
    ...partial,
  };
}

class ScriptedEngine implements AgentEngine {
  readonly requests: PriestRequest[] = [];
  private cursor = 0;

  constructor(private readonly responses: PriestResponse[]) {}

  async run(request: PriestRequest): Promise<PriestResponse> {
    this.requests.push(request);
    const result = this.responses[Math.min(this.cursor, this.responses.length - 1)];
    this.cursor += 1;
    return result;
  }
}

function fakeTool(overrides: Partial<AgentTool> & { name?: string } = {}): AgentTool {
  return {
    definition: { name: overrides.name ?? 'read_file', description: 'fake' },
    kind: overrides.kind ?? 'read',
    summarizeCall: () => `call ${overrides.name ?? 'read_file'}`,
    execute: async () => ({ content: 'tool output' }),
    ...overrides,
  };
}

function makeRunner(engine: AgentEngine, tools: AgentTool[], configOverrides: Parameters<typeof resolveAgentConfig>[0] = {}) {
  const taskStore = new TaskStore(tempDir());
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const runner = new AgentRunner({
    taskStore,
    registry,
    agentConfig: resolveAgentConfig(configOverrides),
    resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent' }),
    prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
  });
  return { runner, taskStore };
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const planResponse = response({ text: '{"title": "Test plan", "steps": ["Read the file", "Summarize"]}' });
const verifyPassResponse = response({ text: '{"passed": true, "notes": "objective met"}' });

describe('AgentRunner', () => {
  it('tallies token usage across plan and loop turns', async () => {
    const withUsage = (partial: Partial<PriestResponse>, usage: { inputTokens: number; outputTokens: number }): PriestResponse =>
      response({ ...partial, usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens, estimatedCostUSD: 0.001 } });
    const engine = new ScriptedEngine([
      withUsage({ text: '{"title": "T", "steps": ["s"]}' }, { inputTokens: 10, outputTokens: 5 }), // plan
      withUsage({ text: 'Final answer.' }, { inputTokens: 20, outputTokens: 8 }), // loop turn
    ]);
    const { runner } = makeRunner(engine, [fakeTool()]);
    const events = await collect(runner.run({ objective: 'Do it.', cwd: tempDir(), forcePlan: true }));
    const done = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 13, totalTokens: 43, estimatedCostUSD: 0.002 });
  });

  it('skips the plan phase by default (adaptive) — first model call is the loop', async () => {
    const engine = new ScriptedEngine([response({ text: 'Direct answer, no plan needed.' })]);
    const { runner } = makeRunner(engine, [fakeTool()]);
    const events = await collect(runner.run({ objective: 'hi', cwd: tempDir() }));
    // No 'plan' event, and the only request is the loop turn (not a plan call).
    expect(events.some(e => e.type === 'plan')).toBe(false);
    expect(engine.requests).toHaveLength(1);
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');
  });

  it('passes the session id to the main loop turns only', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ text: 'Done.' }),
    ]);
    const { runner } = makeRunner(engine, [fakeTool()]);
    await collect(runner.run({ objective: 'Remember this.', cwd: tempDir(), forcePlan: true, sessionId: 'sess-1' }));
    expect(engine.requests[0].session).toBeUndefined(); // plan turn
    expect(engine.requests[1].session).toEqual({ id: 'sess-1', createIfMissing: true }); // loop turn
  });

  function runnerWithHistory(engine: AgentEngine, recent: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunner {
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    return new AgentRunner({
      taskStore: new TaskStore(tempDir()),
      registry,
      agentConfig: resolveAgentConfig({}),
      resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent', maxContextTokens: 16000 }),
      prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
      loadRecentTurns: () => recent,
    });
  }

  it('injects bounded prior-conversation memory into NON-lean runs', async () => {
    const engine = new ScriptedEngine([response({ text: 'Saved.' })]);
    const runner = runnerWithHistory(engine, [
      { role: 'user', content: 'make a prompt' },
      { role: 'assistant', content: 'A colossal spacecraft glides past Jupiter.' },
    ]);
    await collect(runner.run({ objective: 'save the above prompt', cwd: tempDir(), sessionId: 'sess-1' }));
    const ctx = (engine.requests[0].context ?? []).join('\n');
    expect(ctx).toContain('## Earlier in this conversation');
    expect(ctx).toContain('A colossal spacecraft glides past Jupiter.');
  });

  it('keeps lean (skill) runs stateless — no prior conversation injected', async () => {
    const engine = new ScriptedEngine([response({ text: 'Output.' })]);
    const runner = runnerWithHistory(engine, [
      { role: 'user', content: 'prior' },
      { role: 'assistant', content: 'SECRET-PRIOR-OUTPUT' },
    ]);
    await collect(runner.run({ objective: 'run skill', cwd: tempDir(), sessionId: 'sess-1', lean: true, instructions: ['skill body'] }));
    const ctx = (engine.requests[0].context ?? []).join('\n');
    expect(ctx).not.toContain('Earlier in this conversation');
    expect(ctx).not.toContain('SECRET-PRIOR-OUTPUT');
  });

  it('injects lazily selected built-in instructions into ordinary agent runs', async () => {
    const engine = new ScriptedEngine([response({ text: 'Done.' })]);
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    const runner = new AgentRunner({
      taskStore: new TaskStore(tempDir()),
      registry,
      agentConfig: resolveAgentConfig({}),
      resolveSettings: () => ({ profile: 'writer', provider: 'mock', model: 'test-model', think: false, mode: 'agent' }),
      prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
      resolveBuiltInInstructions: (objective, profile) => [`guide for ${profile}: ${objective}`],
    });

    await collect(runner.run({ objective: 'update my skill', instructions: ['caller instruction'] }));

    const context = (engine.requests[0].context ?? []).join('\n');
    expect(context).toContain('guide for writer: update my skill');
    expect(context).toContain('caller instruction');
  });

  it('does not inject built-in manager guidance into an invoked skill run', async () => {
    const engine = new ScriptedEngine([response({ text: 'Output.' })]);
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    const runner = new AgentRunner({
      taskStore: new TaskStore(tempDir()),
      registry,
      agentConfig: resolveAgentConfig({}),
      resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent' }),
      prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
      resolveBuiltInInstructions: () => ['SHOULD-NOT-APPEAR'],
    });

    await collect(runner.run({ objective: 'generate skill text', lean: true, instructions: ['skill body'] }));

    const context = (engine.requests[0].context ?? []).join('\n');
    expect(context).toContain('skill body');
    expect(context).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('caps NON-lean history to the last N turns when session_context_turns is set', async () => {
    const engine = new ScriptedEngine([response({ text: 'Saved.' })]);
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    const recent = [
      { role: 'user' as const, content: 'OLDEST-Q' },
      { role: 'assistant' as const, content: 'oldest-a' },
      { role: 'user' as const, content: 'mid-q' },
      { role: 'assistant' as const, content: 'mid-a' },
      { role: 'user' as const, content: 'NEWEST-Q' },
      { role: 'assistant' as const, content: 'newest-a' },
    ];
    const runner = new AgentRunner({
      taskStore: new TaskStore(tempDir()),
      registry,
      agentConfig: resolveAgentConfig({}),
      resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent', maxContextTokens: 16000, sessionContextTurns: 2 }),
      prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
      loadRecentTurns: () => recent,
    });
    await collect(runner.run({ objective: 'save the above', cwd: tempDir(), sessionId: 'sess-1' }));
    const ctx = (engine.requests[0].context ?? []).join('\n');
    expect(ctx).toContain('## Earlier in this conversation');
    expect(ctx).toContain('NEWEST-Q');     // within the window
    expect(ctx).not.toContain('OLDEST-Q'); // dropped by the turn cap
  });

  it('forwards objective images on the first agent turn only', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ text: 'I can see the image.' }),
    ]);
    const { runner } = makeRunner(engine, [fakeTool()]);
    const images = [{ path: '/tmp/pic.png' }];

    await collect(runner.run({ objective: 'Describe the image.', cwd: tempDir(), forcePlan: true, images }));

    expect(engine.requests[0].images).toBeUndefined(); // plan turn
    expect(engine.requests[1].images).toEqual(images); // first loop turn
  });

  it('prepares images once and honors the one-turn original bypass', async () => {
    const engine = new ScriptedEngine([response({ text: 'I can see it.' })]);
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    const prepareImages = vi.fn(async () => [{ data: 'prepared', mediaType: 'image/png' }]);
    const runner = new AgentRunner({
      taskStore: new TaskStore(tempDir()),
      registry,
      agentConfig: resolveAgentConfig({}),
      resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent' }),
      prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
      prepareImages,
    });

    await collect(runner.run({
      objective: 'Describe it.',
      images: [{ data: 'source', mediaType: 'image/png' }],
      originalImages: true,
    }));

    expect(prepareImages).toHaveBeenCalledWith([{ data: 'source', mediaType: 'image/png' }], false);
    expect(engine.requests[0].images).toEqual([{ data: 'prepared', mediaType: 'image/png' }]);
  });

  it('runs plan, tool loop, and summary with native tool calls', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({
        text: '',
        toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } }],
        execution: { provider: 'mock', model: 'test-model', profile: 'default', finishedReason: 'tool_calls' },
      }),
      response({ text: 'The file says hello.' }),
    ]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Read a.txt and summarize it.', cwd: tempDir(), forcePlan: true }));
    const types = events.map(e => e.type);
    expect(types).toEqual([
      'status', 'plan',
      'tool_request', 'approval_decision', 'tool_result',
      'text', 'status', 'done',
    ]);

    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');
    expect(done.summary).toBe('The file says hello.');

    // The loop prompt steers the model away from gratuitous tool use.
    expect(engine.requests[1].prompt).toContain('Use tools only when');

    // Second loop request must replay the tool exchange.
    const loopRequest = engine.requests[2];
    expect(loopRequest.toolExchange).toMatchObject([
      { kind: 'assistant', toolCalls: [{ name: 'read_file' }] },
      { kind: 'tool_result', toolCallId: 'call_0', content: 'tool output' },
    ]);
    expect(loopRequest.tools?.map(t => t.name)).toEqual(['read_file']);

    // Task state persisted: completed, plan steps completed, events recorded.
    const task = taskStore.get(done.taskId)!;
    expect(task.status).toBe('completed');
    expect(task.title).toBe('Test plan');
    expect(task.plan.map(step => step.status)).toEqual(['completed', 'completed']);
    expect(task.events.some(e => e.kind === 'observation')).toBe(true);
  });

  it('auto-approves an out-of-workspace write inside a trusted folder on an unattended run', async () => {
    // The blog-automation case: a scheduled (no approvalHandler) run writes to a
    // trusted folder outside the workspace — it must execute, not be denied.
    const cwd = tempDir();
    const trusted = tempDir();
    const target = path.join(trusted, 'blog.md');
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'write_file', arguments: { path: target, content: 'hello blog' } }] }),
      response({ text: 'Wrote the blog.' }),
    ]);
    const { runner } = makeRunner(engine, [new WriteFileTool()], { trustedFolders: [trusted] });

    const events = await collect(runner.run({ objective: 'write the daily blog', cwd, forcePlan: true }));

    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision.approved).toBe(true);
    expect(decision.source).toBe('policy'); // trusted-folder auto-approval, not a handler
    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello blog'); // actually written, no prompt
  });

  it('denies ask-mode tools on unattended runs without executing', async () => {
    let executed = 0;
    const engine = new ScriptedEngine([
      planResponse,
      response({
        toolCalls: [{ id: 'call_0', name: 'write_note', arguments: { path: 'n.md' } }],
      }),
      response({ text: 'Stopped because writing was denied.' }),
    ]);
    const tool = fakeTool({
      name: 'write_note',
      kind: 'write',
      execute: async () => { executed += 1; return { content: 'never' }; },
    });
    const { runner } = makeRunner(engine, [tool]);

    const events = await collect(runner.run({ objective: 'Write a note.', cwd: tempDir(), forcePlan: true }));
    expect(executed).toBe(0);

    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision.approved).toBe(false);
    expect(decision.source).toBe('policy');

    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.isError).toBe(true);

    // Denial is replayed to the model as an error tool result.
    const followUp = engine.requests[2];
    expect(followUp.toolExchange?.[1]).toMatchObject({ kind: 'tool_result', isError: true });

    // With no verify phase, a completed loop is 'completed' (the denial is the
    // agent's recorded outcome, surfaced via the error tool result above).
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');
  });

  it('asks the approval handler and honors its decision', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done.' }),
      verifyPassResponse,
    ]);
    const tool = fakeTool({ name: 'write_note', kind: 'write' });
    const { runner } = makeRunner(engine, [tool]);
    const seen: string[] = [];

    const events = await collect(runner.run({
      objective: 'Write.',
      cwd: tempDir(), forcePlan: true,
      approvalHandler: async request => {
        seen.push(request.tool);
        return { approved: true };
      },
    }));

    expect(seen).toEqual(['write_note']);
    const types = events.map(e => e.type);
    expect(types).toContain('approval_request');
    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision).toMatchObject({ approved: true, source: 'user' });
  });

  it('stops at the iteration cap with a failed task', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'read_file', arguments: {} }] }),
    ]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Loop forever.', cwd: tempDir(), forcePlan: true, maxIterations: 2 }));
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('failed');

    const task = taskStore.get(done.taskId)!;
    expect(task.status).toBe('failed');
    expect(task.events.some(e => e.kind === 'blocker')).toBe(true);
  });

  it('cancels when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new ScriptedEngine([planResponse]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Anything.', cwd: tempDir(), forcePlan: true, signal: controller.signal }));
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('cancelled');
    expect(taskStore.get(done.taskId)?.status).toBe('cancelled');
  });

  it('falls back to control-block tools when the provider rejects native tools', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ ok: false, error: { code: 'PROVIDER_ERROR', message: 'model does not support tools', details: {} } }),
      response({ text: 'Let me check.\n<tool_call name="read_file">{"path": "a.txt"}</tool_call>' }),
      response({ text: 'The file says hello.' }),
      verifyPassResponse,
    ]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Read a.txt.', cwd: tempDir(), forcePlan: true, toolMode: 'auto' }));
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');

    // After the fallback the loop request uses control-block instructions, not native tools.
    const fallbackRequest = engine.requests[2];
    expect(fallbackRequest.tools).toBeUndefined();
    expect(fallbackRequest.context?.join('\n')).toContain('<tool_call');

    // The tool result is replayed as transcript text in userContext.
    const followUp = engine.requests[3];
    expect(followUp.userContext?.join('\n')).toContain('<tool_result name="read_file"');
    expect(followUp.userContext?.join('\n')).toContain('tool output');

    const task = taskStore.get(done.taskId)!;
    expect(task.events.some(e => e.kind === 'decision' && e.message.includes('control-block'))).toBe(true);
  });

  it('strips memory control blocks from agent output and discards payloads', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ text: 'Answer ready.<memory_save>{"kind":"user","text":"secret"}</memory_save>' }),
      verifyPassResponse,
    ]);
    const { runner } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Answer.', cwd: tempDir(), forcePlan: true }));
    const text = events.find(e => e.type === 'text') as Extract<AgentEvent, { type: 'text' }>;
    expect(text.text).toBe('Answer ready.');
    expect(text.text).not.toContain('memory_save');
  });

  it('applies [agent.unattended] overrides on unattended runs', async () => {
    let executed = 0;
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done.' }),
      verifyPassResponse,
    ]);
    const tool = fakeTool({
      name: 'write_note',
      kind: 'write',
      execute: async () => { executed += 1; return { content: 'written' }; },
    });
    // write defaults to ask; unattended override allows it without a handler.
    const { runner } = makeRunner(engine, [tool], { unattended: { write: 'allow' } });

    const events = await collect(runner.run({ objective: 'Write.', cwd: tempDir(), forcePlan: true, unattended: true }));
    expect(executed).toBe(1);
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');
  });

  it('drains /btw steering between iterations and surfaces it to the model', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'read_file', arguments: {} }] }),
      response({ text: 'Done with the steering applied.' }),
      verifyPassResponse,
    ]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    let drained = false;
    const events = await collect(runner.run({
      objective: 'Do work.',
      cwd: tempDir(), forcePlan: true,
      steering: () => {
        if (drained) return [];
        drained = true;
        return ['prioritize the summary'];
      },
    }));

    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('completed');

    // The first loop request (after the plan) carries the steering as userContext.
    expect(engine.requests[1].userContext?.join('\n')).toContain('prioritize the summary');
    // The steering is recorded on the task.
    expect(taskStore.get(done.taskId)?.events.some(e => e.message.includes('Steering: prioritize the summary'))).toBe(true);
    // Drained guidance is surfaced on the event stream so attached clients see it.
    const steeringEvents = events.filter((e): e is Extract<AgentEvent, { type: 'steering' }> => e.type === 'steering');
    expect(steeringEvents).toEqual([{ type: 'steering', taskId: done.taskId, text: 'prioritize the summary' }]);
  });

  it('escalates risky calls to ask even when policy allows', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({ toolCalls: [{ id: 'call_0', name: 'risky_read', arguments: {} }] }),
      response({ text: 'Done.' }),
      verifyPassResponse,
    ]);
    const tool = fakeTool({
      name: 'risky_read',
      kind: 'read',
      assessRisk: () => ({ escalate: true, reason: 'outside the workspace' }),
    });
    const { runner } = makeRunner(engine, [tool]);

    // read policy defaults to allow, but escalation + no handler => denied.
    const events = await collect(runner.run({ objective: 'Risky.', cwd: tempDir(), forcePlan: true }));
    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision.approved).toBe(false);
  });
});
