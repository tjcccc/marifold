import { describe, expect, it } from 'vitest';
import type { AgentEvent, MarifoldSkill } from '@marifold/core';
import { parseInput, tokenizeArgs } from '../src/core/inputGrammar.js';
import { agentEventToItems } from '../src/core/eventView.js';
import { appReducer, createInitialState } from '../src/core/appState.js';
import { runCommand, type CommandContext } from '../src/core/commands.js';
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
    expect(runCommand(ctx, 'nope', '')).toBe(false);
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
