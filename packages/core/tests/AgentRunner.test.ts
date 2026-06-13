import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PriestRequest, PriestResponse } from '@priest-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEngine, AgentRunner } from '../src/agent/AgentRunner';
import { AgentEvent } from '../src/agent/AgentEvents';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { AgentTool, ToolRegistry } from '../src/agent/ToolRegistry';
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
    resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false }),
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
  it('runs plan, tool loop, verification, and summary with native tool calls', async () => {
    const engine = new ScriptedEngine([
      planResponse,
      response({
        text: '',
        toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } }],
        execution: { provider: 'mock', model: 'test-model', profile: 'default', finishedReason: 'tool_calls' },
      }),
      response({ text: 'The file says hello.' }),
      verifyPassResponse,
    ]);
    const { runner, taskStore } = makeRunner(engine, [fakeTool()]);

    const events = await collect(runner.run({ objective: 'Read a.txt and summarize it.', cwd: tempDir() }));
    const types = events.map(e => e.type);
    expect(types).toEqual([
      'status', 'plan',
      'tool_request', 'approval_decision', 'tool_result',
      'text', 'verification', 'status', 'done',
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
    expect(task.events.some(e => e.kind === 'verification')).toBe(true);
  });

  it('denies ask-mode tools on unattended runs without executing', async () => {
    let executed = 0;
    const engine = new ScriptedEngine([
      planResponse,
      response({
        toolCalls: [{ id: 'call_0', name: 'write_note', arguments: { path: 'n.md' } }],
      }),
      response({ text: 'Stopped because writing was denied.' }),
      response({ text: '{"passed": false, "notes": "write denied"}' }),
    ]);
    const tool = fakeTool({
      name: 'write_note',
      kind: 'write',
      execute: async () => { executed += 1; return { content: 'never' }; },
    });
    const { runner } = makeRunner(engine, [tool]);

    const events = await collect(runner.run({ objective: 'Write a note.', cwd: tempDir() }));
    expect(executed).toBe(0);

    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision.approved).toBe(false);
    expect(decision.source).toBe('policy');

    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.isError).toBe(true);

    // Denial is replayed to the model as an error tool result.
    const followUp = engine.requests[2];
    expect(followUp.toolExchange?.[1]).toMatchObject({ kind: 'tool_result', isError: true });

    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.status).toBe('blocked');
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
      cwd: tempDir(),
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

    const events = await collect(runner.run({ objective: 'Loop forever.', cwd: tempDir(), maxIterations: 2 }));
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

    const events = await collect(runner.run({ objective: 'Anything.', cwd: tempDir(), signal: controller.signal }));
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

    const events = await collect(runner.run({ objective: 'Read a.txt.', cwd: tempDir(), toolMode: 'auto' }));
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

    const events = await collect(runner.run({ objective: 'Answer.', cwd: tempDir() }));
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

    const events = await collect(runner.run({ objective: 'Write.', cwd: tempDir(), unattended: true }));
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
      cwd: tempDir(),
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
    const events = await collect(runner.run({ objective: 'Risky.', cwd: tempDir() }));
    const decision = events.find(e => e.type === 'approval_decision') as Extract<AgentEvent, { type: 'approval_decision' }>;
    expect(decision.approved).toBe(false);
  });
});
