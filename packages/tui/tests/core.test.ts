import { describe, expect, it } from 'vitest';
import type { AgentEvent, MarifoldSkill } from '@marifold/core';
import { parseInput, tokenizeArgs } from '../src/core/inputGrammar.js';
import { agentEventToItems } from '../src/core/eventView.js';
import { appReducer, createInitialState } from '../src/core/appState.js';
import { listCommandCompletions, runCommand, type CommandContext } from '../src/core/commands.js';
import { bindSkillArgs, skillUsage } from '../src/core/skills.js';

function initial() {
  return createInitialState({ profile: 'default', provider: 'ollama', model: 'm', cwd: '/tmp', version: '0.0.0-test' });
}

describe('inputGrammar', () => {
  it('classifies text, commands, and skills', () => {
    expect(parseInput('hello there')).toEqual({ kind: 'text', text: 'hello there' });
    expect(parseInput('   ')).toEqual({ kind: 'empty' });
    expect(parseInput('/model gpt')).toEqual({ kind: 'command', name: 'model', args: 'gpt', argv: ['gpt'] });
    expect(parseInput('$translate hi there')).toEqual({
      kind: 'skill', name: 'translate', args: 'hi there', argv: ['hi', 'there'],
    });
  });

  it('lowercases the head token and tokenizes quoted args', () => {
    const cmd = parseInput('/MODEL');
    expect(cmd.kind).toBe('command');
    if (cmd.kind === 'command') expect(cmd.name).toBe('model');
    expect(tokenizeArgs('"good morning" ja')).toEqual(['good morning', 'ja']);
  });
});

describe('eventView', () => {
  it('maps each AgentEvent variant', () => {
    const plan = agentEventToItems({ type: 'plan', taskId: 't', plan: [{ id: 's1', text: 'step', status: 'pending' }] } as AgentEvent);
    expect(plan[0]).toMatchObject({ kind: 'plan' });
    expect(agentEventToItems({ type: 'text', text: 'hi' })[0]).toMatchObject({ kind: 'assistant', text: 'hi' });
    expect(agentEventToItems({ type: 'text', text: '   ' })).toEqual([]);
    expect(agentEventToItems({ type: 'tool_request', call: { id: 'c', tool: 'read_file', kind: 'read', input: {}, summary: 's' } })[0])
      .toMatchObject({ kind: 'tool', phase: 'request', toolKind: 'read' });
    expect(agentEventToItems({ type: 'tool_result', callId: 'c', tool: 'read_file', summary: 'ok', isError: false })[0])
      .toMatchObject({ kind: 'tool', phase: 'result' });
    expect(agentEventToItems({ type: 'approval_decision', requestId: 'c', approved: true, source: 'user' })).toEqual([]);
    expect(agentEventToItems({ type: 'approval_decision', requestId: 'c', approved: false, source: 'user', reason: 'no' })[0])
      .toMatchObject({ kind: 'notice', tone: 'warn' });
    expect(agentEventToItems({ type: 'verification', passed: true, notes: 'n' })[0]).toMatchObject({ kind: 'verification', passed: true });
    expect(agentEventToItems({ type: 'error', code: 'X', message: 'm' })[0]).toMatchObject({ kind: 'notice', tone: 'error' });
    // done produces no item; the App emits the completion line with timing/tokens.
    expect(agentEventToItems({ type: 'done', taskId: 't', status: 'completed' })).toEqual([]);
    // status/step/approval_request produce no transcript item.
    expect(agentEventToItems({ type: 'status', taskId: 't', status: 'running' })).toEqual([]);
  });
});

describe('appReducer', () => {
  it('adds user input and streams assistant deltas into one item', () => {
    let state = appReducer(initial(), { type: 'add_user', text: 'hi' });
    state = appReducer(state, { type: 'assistant_delta', text: 'Hel' });
    state = appReducer(state, { type: 'assistant_delta', text: 'lo' });
    expect(state.transcript).toHaveLength(2);
    expect(state.transcript[1]).toMatchObject({ kind: 'assistant', text: 'Hello' });
    state = appReducer(state, { type: 'end_assistant' });
    state = appReducer(state, { type: 'assistant_delta', text: 'next' });
    expect(state.transcript).toHaveLength(3);
  });

  it('folds a tool result onto its request row (one self-updating line)', () => {
    let state = appReducer(initial(), { type: 'set_running', running: true });
    state = appReducer(state, { type: 'agent_event', event: { type: 'tool_request', call: { id: 'c1', tool: 'read_file', kind: 'read', input: {}, summary: 'read vars.toml' } } });
    expect(state.transcript.filter(i => i.kind === 'tool')).toHaveLength(1);
    state = appReducer(state, { type: 'agent_event', event: { type: 'tool_result', callId: 'c1', tool: 'read_file', summary: 'read 2.0KB from vars.toml', isError: false } });
    const tools = state.transcript.filter(i => i.kind === 'tool');
    expect(tools).toHaveLength(1); // folded, not appended as a second row
    expect(tools[0]).toMatchObject({ kind: 'tool', phase: 'result', summary: 'read 2.0KB from vars.toml', callId: 'c1' });
  });

  it('folds agent events into transcript and approval/run state', () => {
    let state = appReducer(initial(), { type: 'set_running', running: true });
    const request = { id: 'c', tool: 'write_note', kind: 'write' as const, summary: 's', input: {}, escalated: false };
    state = appReducer(state, { type: 'agent_event', event: { type: 'approval_request', request } });
    expect(state.approval).toEqual(request);
    state = appReducer(state, { type: 'agent_event', event: { type: 'approval_decision', requestId: 'c', approved: true, source: 'user' } });
    expect(state.approval).toBeUndefined();
    state = appReducer(state, { type: 'agent_event', event: { type: 'done', taskId: 't', status: 'completed' } });
    expect(state.running).toBe(false);
  });

  it('clears transcript on new_session', () => {
    let state = appReducer(initial(), { type: 'add_user', text: 'x' });
    state = appReducer(state, { type: 'new_session', sessionId: 's1' });
    expect(state.transcript).toEqual([]);
    expect(state.sessionId).toBe('s1');
  });

  it('tracks the context gauge: budget, usage, and resets across session/profile', () => {
    let state = appReducer({ ...initial(), maxContextTokens: 16000 }, { type: 'set_context_usage', tokens: 9900 });
    expect(state.contextTokens).toBe(9900);

    // A new session clears measured usage but keeps the budget.
    state = appReducer(state, { type: 'new_session', sessionId: 's2' });
    expect(state.contextTokens).toBeUndefined();
    expect(state.maxContextTokens).toBe(16000);

    // set_context_budget changes the budget in place.
    state = appReducer(state, { type: 'set_context_budget', maxContextTokens: 24000 });
    expect(state.maxContextTokens).toBe(24000);

    // Switching profile applies the new profile's budget and resets usage.
    state = appReducer({ ...state, contextTokens: 5000 }, { type: 'set_profile', profile: 'p2', provider: 'x', model: 'm', maxContextTokens: 8000 });
    expect(state.maxContextTokens).toBe(8000);
    expect(state.contextTokens).toBeUndefined();
  });

  it('seeds a resumed transcript with continuous ids and seq', () => {
    const state = createInitialState({
      profile: 'default', provider: 'ollama', model: 'm', cwd: '/tmp', version: '0.0.0-test',
      sessionId: 'sess-1',
      transcript: [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', text: 'hi there' },
      ],
    });
    expect(state.sessionId).toBe('sess-1');
    expect(state.transcript).toEqual([
      { id: 'item_1', kind: 'user', text: 'hello' },
      { id: 'item_2', kind: 'assistant', text: 'hi there' },
    ]);
    // A new item must continue past the seeded ids rather than collide.
    const next = appReducer(state, { type: 'add_user', text: 'next' });
    expect(next.transcript[2]).toMatchObject({ id: 'item_3', kind: 'user', text: 'next' });
  });
});

function fakeCtx(): { ctx: CommandContext; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]) => { calls[name] = args; };
  const ctx = {
    notify: record('notify'), setMode: record('setMode'), setDefaultMode: record('setDefaultMode'), newSession: record('newSession'),
    clear: record('clear'), stop: record('stop'), steer: record('steer'), exit: record('exit'),
    setThink: record('setThink'), openModelPicker: record('openModelPicker'), openProfilePicker: record('openProfilePicker'),
    openSkills: record('openSkills'), showPermissions: record('showPermissions'), showHelp: record('showHelp'),
    showSessions: record('showSessions'), runDoctor: record('runDoctor'), installSkill: record('installSkill'),
    readFile: record('readFile'), setImage: record('setImage'),
    remember: record('remember'), forget: record('forget'), deleteMemory: record('deleteMemory'),
    showContextWindow: record('showContextWindow'), setContextWindow: record('setContextWindow'),
    setDefaultContextWindow: record('setDefaultContextWindow'), compactNow: record('compactNow'),
  } as unknown as CommandContext;
  return { ctx, calls };
}

describe('commands', () => {
  it('dispatches known commands and reports unknown ones', () => {
    const { ctx, calls } = fakeCtx();
    expect(runCommand(ctx, 'chat', '')).toBe(true);
    expect(calls.setMode).toEqual(['chat']);
    expect(runCommand(ctx, 'btw', 'focus here')).toBe(true);
    expect(calls.steer).toEqual(['focus here']);
    expect(runCommand(ctx, 'quit', '')).toBe(true); // alias of exit
    expect(calls.exit).toBeDefined();
    expect(runCommand(ctx, 'resume', '')).toBe(true);
    expect(calls.showSessions).toBeDefined();
    expect(runCommand(ctx, 'session', '')).toBe(true); // compatibility alias
    expect(runCommand(ctx, 'nope', '')).toBe(false);
  });

  it('includes compatibility aliases in command completion', () => {
    expect(listCommandCompletions()).toContainEqual({
      name: 'session',
      hint: 'Alias for /resume. Resume a recent session from an interactive picker.',
    });
  });

  it('routes mode commands: bare = session, "default" = persist', () => {
    const { ctx, calls } = fakeCtx();
    runCommand(ctx, 'agent', '');
    expect(calls.setMode).toEqual(['agent']);
    expect(calls.setDefaultMode).toBeUndefined();
    runCommand(ctx, 'chat', 'default');
    expect(calls.setDefaultMode).toEqual(['chat']);
  });

  it('validates think argument', () => {
    const { ctx, calls } = fakeCtx();
    runCommand(ctx, 'think', 'on');
    expect(calls.setThink).toEqual([true]);
    runCommand(ctx, 'think', 'sideways');
    expect(calls.notify).toBeDefined();
  });

  it('routes /context-window: status, session set, profile default, off, and k-suffix', () => {
    const { ctx, calls } = fakeCtx();
    runCommand(ctx, 'context-window', '');
    expect(calls.showContextWindow).toBeDefined();

    runCommand(ctx, 'context-window', 'set 16000');
    expect(calls.setContextWindow).toEqual([16000]);

    runCommand(ctx, 'context-window', 'set 16k');
    expect(calls.setContextWindow).toEqual([16000]);

    runCommand(ctx, 'context-window', 'set 24000 default');
    expect(calls.setDefaultContextWindow).toEqual([24000]);

    runCommand(ctx, 'context-window', 'set off');
    expect(calls.setContextWindow).toEqual([undefined]);

    runCommand(ctx, 'ctx', 'set off default'); // alias + disable default
    expect(calls.setDefaultContextWindow).toEqual([undefined]);
  });

  it('rejects an invalid /context-window token argument', () => {
    const { ctx, calls } = fakeCtx();
    runCommand(ctx, 'context-window', 'set lots');
    expect(calls.setContextWindow).toBeUndefined();
    expect(calls.notify).toBeDefined();
  });

  it('/compact triggers a manual fold', () => {
    const { ctx, calls } = fakeCtx();
    expect(runCommand(ctx, 'compact', '')).toBe(true);
    expect(calls.compactNow).toBeDefined();
  });
});

describe('skills binding', () => {
  const skill: MarifoldSkill = {
    name: 'translate', description: '', prompt: '{{language}} {{text}}', mode: 'chat',
    variables: [
      { name: 'language', required: false, default: 'English' },
      { name: 'text', required: true },
    ],
  };

  it('binds positional args, last variable absorbs the rest', () => {
    expect(bindSkillArgs(skill, ['ja', 'good', 'morning'])).toEqual({ language: 'ja', text: 'good morning' });
    expect(bindSkillArgs(skill, [])).toEqual({});
  });

  it('formats usage', () => {
    expect(skillUsage(skill)).toBe('$translate [language] <text>');
  });
});
