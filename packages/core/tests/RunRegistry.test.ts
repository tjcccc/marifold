import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PriestRequest, PriestResponse } from '@priest-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEngine, AgentRunner } from '../src/agent/AgentRunner';
import { AgentEvent } from '../src/agent/AgentEvents';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { AgentTool, ToolRegistry } from '../src/agent/ToolRegistry';
import { WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { AskUserTool } from '../src/agent/tools/AskUserTool';
import { MarifoldError } from '../src/errors/MarifoldError';
import { RunRegistry, RunRegistryOptions, SequencedEvent } from '../src/runs/RunRegistry';
import { TaskStore } from '../src/tasks/TaskStore';

const tempDirs: string[] = [];
const registries: RunRegistry[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-runreg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
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

interface Harness {
  registry: RunRegistry;
  engines: ScriptedEngine[];
  grants: Array<{ profile: string; kind: string; mode: string }>;
  folders: Array<{ profile: string; folder: string }>;
}

function makeRegistry(
  script: PriestResponse[],
  tools: AgentTool[],
  options: Partial<Omit<RunRegistryOptions, 'runtime'>> = {},
): Harness {
  const engines: ScriptedEngine[] = [];
  const grants: Harness['grants'] = [];
  const folders: Harness['folders'] = [];
  const registry = new RunRegistry({
    runtime: {
      createAgentRunner: () => {
        const engine = new ScriptedEngine(script);
        engines.push(engine);
        const toolRegistry = new ToolRegistry();
        for (const tool of tools) toolRegistry.register(tool);
        return new AgentRunner({
          taskStore: new TaskStore(tempDir()),
          registry: toolRegistry,
          agentConfig: resolveAgentConfig({}),
          resolveSettings: () => ({ profile: 'default', provider: 'mock', model: 'test-model', think: false, mode: 'agent' }),
          prepareEngine: async () => ({ engine, config: { provider: 'mock', model: 'test-model' } }),
        });
      },
      setProfileAgentApproval: (profile, kind, mode) => { grants.push({ profile, kind, mode }); },
      addProfileTrustedFolder: (profile, folder) => { folders.push({ profile, folder }); return folder; },
      defaultProfile: () => 'default',
    },
    ...options,
  });
  registries.push(registry);
  return { registry, engines, grants, folders };
}

/** Pull from an events generator until the predicate matches (or it ends).
 * Uses next() rather than for-await so the generator stays open for reuse. */
async function pullUntil(
  gen: AsyncGenerator<SequencedEvent>,
  predicate: (event: AgentEvent) => boolean,
): Promise<{ matched?: SequencedEvent; seen: SequencedEvent[] }> {
  const seen: SequencedEvent[] = [];
  while (true) {
    const result = await gen.next();
    if (result.done) return { seen };
    seen.push(result.value);
    if (predicate(result.value.event)) return { matched: result.value, seen };
  }
}

async function drain(gen: AsyncGenerator<SequencedEvent>): Promise<SequencedEvent[]> {
  return (await pullUntil(gen, () => false)).seen;
}

/** A tool whose execute() blocks until the test releases it, so a run can be
 * deterministically held mid-iteration. */
function gatedTool(name: string): { tool: AgentTool; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = fakeTool({
    name,
    execute: async () => {
      await gate;
      return { content: 'tool output' };
    },
  });
  return { tool, release };
}

const doneEvent = (e: AgentEvent): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done';

describe('RunRegistry', () => {
  it('start() returns a record immediately; events replay through done', async () => {
    const { registry } = makeRegistry([response({ text: 'All done.' })], [fakeTool()]);
    const record = registry.start({ objective: 'Say hi.', cwd: tempDir() });
    expect(record.id).toMatch(/^run_/);
    expect(record.status).toBe('running');
    expect(record.pendingApprovals).toEqual([]);
    expect(record.pendingUserInputs).toEqual([]);

    const events = await drain(registry.events(record.id, 0));
    expect(events[0].seq).toBe(1);
    expect(events[0].event).toMatchObject({ type: 'status', status: 'running' });
    const done = events[events.length - 1].event;
    expect(done).toMatchObject({ type: 'done', status: 'completed' });

    const finished = registry.require(record.id);
    expect(finished.status).toBe('completed');
    expect(finished.taskId).toMatch(/^task_/);
    expect(finished.finishedAt).toBeDefined();
    expect(finished.eventCount).toBe(events.length);
  });

  it('replays for late subscribers and resumes from afterSeq', async () => {
    const { registry } = makeRegistry([response({ text: 'All done.' })], [fakeTool()]);
    const record = registry.start({ objective: 'Say hi.', cwd: tempDir() });
    const all = await drain(registry.events(record.id, 0));
    expect(all.length).toBeGreaterThan(2);

    // A subscriber attaching after completion still sees the whole stream.
    const replay = await drain(registry.events(record.id, 0));
    expect(replay).toEqual(all);

    // afterSeq resumes mid-stream without duplicates.
    const tail = await drain(registry.events(record.id, all[0].seq));
    expect(tail).toEqual(all.slice(1));
  });

  it('parks an ask-gated tool call until a client answers "once"', async () => {
    let executed = 0;
    const tool = fakeTool({
      name: 'write_note',
      kind: 'write',
      execute: async () => { executed += 1; return { content: 'written' }; },
    });
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done.' }),
    ], [tool]);

    const record = registry.start({ objective: 'Write.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, e => e.type === 'approval_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;

    expect(registry.require(record.id).pendingApprovals).toMatchObject([{ id: request.id, tool: 'write_note', kind: 'write' }]);
    expect(executed).toBe(0);

    expect(registry.answerApproval(record.id, request.id, 'once')).toEqual({ requestId: request.id, approved: true });
    const { matched: done, seen } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'completed' });
    expect(executed).toBe(1);
    expect(seen.some(({ event }) => event.type === 'approval_decision' && event.approved && event.source === 'user')).toBe(true);
    expect(registry.require(record.id).pendingApprovals).toEqual([]);
  });

  it('parks ask_user until a client submits every answer, then resumes the run', async () => {
    const { registry, engines } = makeRegistry([
      response({
        toolCalls: [{
          id: 'call_question',
          name: 'ask_user',
          arguments: {
            questions: [{
              id: 'style',
              question: 'What style do you prefer?',
              options: [{ id: 'apple', label: 'Apple' }, { id: 'material', label: 'Material' }],
            }],
          },
        }],
      }),
      response({ text: 'Created the requested style.' }),
    ], [new AskUserTool()]);

    const record = registry.start({ objective: 'Create a design.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, event => event.type === 'user_input_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'user_input_request' }>).request;
    expect(registry.require(record.id).pendingUserInputs).toEqual([request]);

    expect(() => registry.answerUserInput(record.id, request.id, { answers: [] })).toThrow(/Every question/);
    expect(registry.require(record.id).pendingUserInputs).toEqual([request]);
    expect(registry.answerUserInput(record.id, request.id, {
      answers: [{ questionId: 'style', optionId: 'apple' }],
    })).toEqual({ requestId: request.id, accepted: true });

    const { matched: done, seen } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'completed' });
    expect(seen.some(({ event }) => event.type === 'user_input_response'
      && event.response.answers[0].value === 'Apple')).toBe(true);
    expect(engines[0].requests[1].toolExchange?.[1]).toMatchObject({
      content: expect.stringContaining('style: Apple'),
    });
    expect(registry.require(record.id).pendingUserInputs).toEqual([]);
  });

  it('cancel() while ask_user is pending unblocks the run immediately', async () => {
    const { registry } = makeRegistry([
      response({
        toolCalls: [{
          id: 'call_question',
          name: 'ask_user',
          arguments: {
            questions: [{
              id: 'style',
              question: 'Choose.',
              options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
            }],
          },
        }],
      }),
    ], [new AskUserTool()]);
    const record = registry.start({ objective: 'Create.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    await pullUntil(stream, event => event.type === 'user_input_request');

    registry.cancel(record.id);
    const { matched: done } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'cancelled' });
    expect(registry.require(record.id).pendingUserInputs).toEqual([]);
  });

  it('"always" persists the kind to the profile and auto-approves later calls this run', async () => {
    const { registry, grants } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ toolCalls: [{ id: 'call_1', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done.' }),
    ], [fakeTool({ name: 'write_note', kind: 'write' })]);

    const record = registry.start({ objective: 'Write twice.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, e => e.type === 'approval_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;

    registry.answerApproval(record.id, request.id, 'always');
    expect(grants).toEqual([{ profile: 'default', kind: 'write', mode: 'allow' }]);

    // The second call must complete without another client answer: the run's
    // grant layer short-circuits it (a stalled pull here would time out).
    const { matched: done, seen } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'completed' });
    const results = seen.filter(({ event }) => event.type === 'tool_result');
    expect(results).toHaveLength(2);
  });

  it('refuses persistent trust outside home and requires each external write once', async () => {
    const workspace = tempDir();
    const outside = tempDir();
    const { registry, folders } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_file', arguments: { path: path.join(outside, 'a.txt'), content: 'A' } }] }),
      response({ toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: path.join(outside, 'b.txt'), content: 'B' } }] }),
      response({ text: 'Done.' }),
    ], [new WriteFileTool()]);

    const record = registry.start({ objective: 'Write outside.', cwd: workspace });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, e => e.type === 'approval_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;
    expect(request.escalated).toBe(true);
    expect(request.escalatedPath).toBe(path.join(outside, 'a.txt'));
    expect(request.persistable).toBe(false);

    expect(() => registry.answerApproval(record.id, request.id, 'trust')).toThrow(/one call at a time/);
    registry.answerApproval(record.id, request.id, 'once');
    expect(folders).toEqual([]);

    const { matched: second } = await pullUntil(stream, e => e.type === 'approval_request');
    const secondRequest = (second!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;
    expect(secondRequest.id).toBe('call_1');
    expect(secondRequest.persistable).toBe(false);
    registry.answerApproval(record.id, secondRequest.id, 'once');

    const { matched: done } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'completed' });
    expect(fs.readFileSync(path.join(outside, 'a.txt'), 'utf-8')).toBe('A');
    expect(fs.readFileSync(path.join(outside, 'b.txt'), 'utf-8')).toBe('B');
  });

  it('"trust" without an escalated path is rejected', async () => {
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done.' }),
    ], [fakeTool({ name: 'write_note', kind: 'write' })]);

    const record = registry.start({ objective: 'Write.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, e => e.type === 'approval_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;

    expect(() => registry.answerApproval(record.id, request.id, 'trust'))
      .toThrow(/no escalated path/);
    // The prompt is still pending; a follow-up answer resolves it.
    registry.answerApproval(record.id, request.id, 'once');
    await drain(stream);
  });

  it('"deny" surfaces a denied decision and an isError tool result', async () => {
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Stopped politely.' }),
    ], [fakeTool({ name: 'write_note', kind: 'write' })]);

    const record = registry.start({ objective: 'Write.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    const { matched } = await pullUntil(stream, e => e.type === 'approval_request');
    const request = (matched!.event as Extract<AgentEvent, { type: 'approval_request' }>).request;

    expect(registry.answerApproval(record.id, request.id, 'deny')).toEqual({ requestId: request.id, approved: false });
    const { seen } = await pullUntil(stream, doneEvent);
    expect(seen.some(({ event }) => event.type === 'approval_decision' && !event.approved && event.source === 'user')).toBe(true);
    expect(seen.some(({ event }) => event.type === 'tool_result' && event.isError)).toBe(true);
  });

  it('auto-denies an unanswered approval after the timeout', async () => {
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'Done without it.' }),
    ], [fakeTool({ name: 'write_note', kind: 'write' })], { approvalTimeoutMs: 30 });

    const record = registry.start({ objective: 'Write.', cwd: tempDir() });
    const events = await drain(registry.events(record.id, 0));
    const decision = events.find(({ event }) => event.type === 'approval_decision' && event.source === 'user');
    expect(decision!.event).toMatchObject({ approved: false, reason: 'no response to the approval prompt' });
    expect(registry.require(record.id).pendingApprovals).toEqual([]);
  });

  it('cancel() while an approval is pending unblocks the run immediately', async () => {
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'write_note', arguments: {} }] }),
      response({ text: 'unreachable' }),
    ], [fakeTool({ name: 'write_note', kind: 'write' })]);

    const record = registry.start({ objective: 'Write.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    await pullUntil(stream, e => e.type === 'approval_request');

    // Default approval timeout is five minutes — if cancel did not resolve the
    // pending prompt, this drain would hang far past the test timeout.
    expect(registry.cancel(record.id)).toBe('running');
    const { matched: done } = await pullUntil(stream, doneEvent);
    expect(done!.event).toMatchObject({ type: 'done', status: 'cancelled' });
    expect(registry.require(record.id).status).toBe('cancelled');
    expect(registry.cancel(record.id)).toBe('cancelled'); // idempotent
  });

  it('steer() lands in the next iteration and emits a steering event', async () => {
    const { tool, release } = gatedTool('read_note');
    const { registry, engines } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'read_note', arguments: {} }] }),
      response({ text: 'Done with guidance.' }),
    ], [tool]);

    const record = registry.start({ objective: 'Read.', cwd: tempDir() });
    const stream = registry.events(record.id, 0);
    // Steer after iteration 1 is in flight so the note lands on iteration 2.
    const { seen: head } = await pullUntil(stream, e => e.type === 'tool_request');
    registry.steer(record.id, 'prefer the short answer');
    release();

    const events = [...head, ...await drain(stream)];
    const steering = events.find(({ event }) => event.type === 'steering');
    expect(steering!.event).toMatchObject({ type: 'steering', text: 'prefer the short answer' });
    expect(engines[0].requests[1].userContext?.join('\n')).toContain('prefer the short answer');

    expect(() => registry.steer(record.id, 'too late')).toThrow(/already finished/);
  });

  it('enforces the active-run limit', async () => {
    const { tool, release } = gatedTool('read_note');
    const { registry } = makeRegistry([
      response({ toolCalls: [{ id: 'call_0', name: 'read_note', arguments: {} }] }),
      response({ text: 'Done.' }),
    ], [tool], { maxActiveRuns: 1 });

    const record = registry.start({ objective: 'First.', cwd: tempDir() });
    try {
      registry.start({ objective: 'Second.', cwd: tempDir() });
      expect.unreachable('second start should have thrown');
    } catch (error) {
      expect((error as MarifoldError).code).toBe('RUN_LIMIT_EXCEEDED');
    }
    release();
    await drain(registry.events(record.id, 0));
    // With the first run finished, capacity frees up.
    const second = registry.start({ objective: 'Second.', cwd: tempDir() });
    release();
    await drain(registry.events(second.id, 0));
  });

  it('evicts finished runs after the TTL', async () => {
    const { registry } = makeRegistry([response({ text: 'Done.' })], [fakeTool()], { finishedRunTtlMs: 1 });
    const record = registry.start({ objective: 'Quick.', cwd: tempDir() });
    await drain(registry.events(record.id, 0));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(registry.list().some(run => run.id === record.id)).toBe(false);
    expect(registry.get(record.id)).toBeUndefined();
  });

  it('caps the event buffer and replays from firstSeq', async () => {
    const { registry } = makeRegistry([response({ text: 'Done.' })], [fakeTool()], { maxBufferedEvents: 2 });
    const record = registry.start({ objective: 'Quick.', cwd: tempDir() });
    // Wait for completion via polling the record (the live stream would race
    // the cap since early events drop out from under a slow subscriber).
    while (registry.require(record.id).status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const events = await drain(registry.events(record.id, 0));
    expect(events).toHaveLength(2);
    const total = registry.require(record.id).eventCount;
    expect(events.map(e => e.seq)).toEqual([total - 1, total]);
    expect(events[events.length - 1].event.type).toBe('done');
  });

  it('rejects unknown runs and unknown approvals with typed errors', async () => {
    const { registry } = makeRegistry([response({ text: 'Done.' })], [fakeTool()]);
    const record = registry.start({ objective: 'Quick.', cwd: tempDir() });
    await drain(registry.events(record.id, 0));

    for (const call of [
      () => registry.require('run_nope'),
      () => registry.steer('run_nope', 'x'),
      () => registry.cancel('run_nope'),
      () => registry.answerApproval('run_nope', 'req', 'once'),
      () => registry.answerUserInput('run_nope', 'req', { answers: [] }),
    ]) {
      try {
        call();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as MarifoldError).code).toBe('RUN_NOT_FOUND');
      }
    }

    try {
      registry.answerApproval(record.id, 'req_bogus', 'once');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as MarifoldError).code).toBe('APPROVAL_NOT_FOUND');
    }

    try {
      registry.answerUserInput(record.id, 'req_bogus', { answers: [] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as MarifoldError).code).toBe('USER_INPUT_NOT_FOUND');
    }
  });
});
