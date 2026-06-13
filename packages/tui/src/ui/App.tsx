import React, { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, useApp } from 'ink';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigManager,
  expandHome,
  formatSearchContext,
  renderSkillPrompt,
  resolveAgentConfig,
} from '@marifold/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ImageInput,
  LoadedMarifoldConfig,
  MarifoldRuntime,
  MarifoldSkill,
  ToolKind,
} from '@marifold/core';
import { appReducer, createInitialState, type Mode, type NoticeTone } from '../core/appState.js';
import { parseInput } from '../core/inputGrammar.js';
import { listCommands, runCommand, type CommandContext } from '../core/commands.js';
import { bindSkillArgs, skillUsage } from '../core/skills.js';
import { Header } from './Header.js';
import { TranscriptRow } from './Transcript.js';
import { InputBox } from './InputBox.js';
import { StatusLine } from './StatusLine.js';
import { ApprovalModal, type ApprovalChoice } from './ApprovalModal.js';
import { SelectList, type SelectItem } from './SelectList.js';
import { InfoPanel } from './InfoPanel.js';

const READ_FILE_CHAR_LIMIT = 100000;

export interface AppProps {
  runtime: MarifoldRuntime;
  loadedConfig: LoadedMarifoldConfig;
  initial: { profile: string; provider: string; model: string; think: boolean; cwd: string };
}

type Overlay =
  | { type: 'model' | 'profile' | 'skills' | 'sessions'; items: SelectItem[] }
  | { type: 'info'; title: string; lines: string[] };

interface PendingSkill {
  skill: MarifoldSkill;
  supplied: Record<string, string>;
  missing: string[];
  index: number;
}

export function App({ runtime, loadedConfig, initial }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    appReducer,
    createInitialState({ profile: initial.profile, provider: initial.provider, model: initial.model, cwd: initial.cwd }),
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [think, setThink] = useState(initial.think);
  const [steeringCount, setSteeringCount] = useState(0);
  const [pendingSkill, setPendingSkill] = useState<PendingSkill | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [skillNames, setSkillNames] = useState<string[]>(() => {
    try {
      return runtime.listSkills(initial.profile).map(skill => skill.name);
    } catch {
      return [];
    }
  });
  const commandNames = useMemo(
    () => listCommands().flatMap(spec => [spec.name, ...(spec.aliases ?? [])]),
    [],
  );

  // Mutable run plumbing (does not drive rendering directly).
  const abortRef = useRef<AbortController | null>(null);
  const cancelChatRef = useRef(false);
  const approvalResolverRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const sessionGrantsRef = useRef<Set<ToolKind>>(new Set());
  const steeringRef = useRef<string[]>([]);
  const pendingContextRef = useRef<string[]>([]);
  const pendingImagesRef = useRef<ImageInput[]>([]);
  const lastCtrlCRef = useRef(0);

  // Latest state for callbacks that must read current values without re-binding.
  const stateRef = useRef(state);
  stateRef.current = state;
  const thinkRef = useRef(think);
  thinkRef.current = think;

  const notify = useCallback((text: string, tone: NoticeTone = 'info') => {
    dispatch({ type: 'notice', tone, text });
  }, []);

  const refreshSkills = useCallback(() => {
    try {
      setSkillNames(runtime.listSkills(stateRef.current.profile).map(skill => skill.name));
    } catch {
      setSkillNames([]);
    }
  }, [runtime]);

  // --- Approvals -----------------------------------------------------------
  const approvalHandler = useCallback((request: ApprovalRequest): Promise<ApprovalDecision> => {
    // Escalated calls always prompt; a session grant only auto-approves
    // ordinary calls of the same kind.
    if (!request.escalated && sessionGrantsRef.current.has(request.kind)) {
      return Promise.resolve({ approved: true });
    }
    dispatch({ type: 'set_approval', request });
    return new Promise<ApprovalDecision>(resolve => {
      approvalResolverRef.current = resolve;
    });
  }, []);

  const resolveApproval = useCallback((choice: ApprovalChoice) => {
    const request = stateRef.current.approval;
    const resolve = approvalResolverRef.current;
    approvalResolverRef.current = null;
    dispatch({ type: 'set_approval', request: undefined });
    if (!request || !resolve) return;
    if (choice === 'deny') {
      resolve({ approved: false, reason: 'denied by user' });
      return;
    }
    if (choice === 'session') {
      sessionGrantsRef.current.add(request.kind);
    } else if (choice === 'persist') {
      sessionGrantsRef.current.add(request.kind);
      persistApprovalKind(request.kind);
    }
    resolve({ approved: true });
  }, []);

  const persistApprovalKind = useCallback((kind: ToolKind) => {
    try {
      const agent = resolveAgentConfig(loadedConfig.config.agent);
      loadedConfig.config.agent = { ...agent, approval: { ...agent.approval, [kind]: 'allow' } };
      new ConfigManager(loadedConfig).save();
      notify(`Persisted approval: ${kind} = allow`, 'info');
    } catch (error) {
      notify(`Could not persist approval: ${errorText(error)}`, 'error');
    }
  }, [loadedConfig, notify]);

  // --- Runs ----------------------------------------------------------------
  const runAgent = useCallback(async (objective: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    steeringRef.current = [];
    setSteeringCount(0);
    dispatch({ type: 'set_running', running: true });
    try {
      const runner = runtime.createAgentRunner();
      const current = stateRef.current;
      for await (const event of runner.run({
        objective,
        profile: current.profile,
        provider: current.provider,
        model: current.model,
        signal: controller.signal,
        approvalHandler,
        steering: () => {
          const queued = steeringRef.current;
          steeringRef.current = [];
          setSteeringCount(0);
          return queued;
        },
      })) {
        dispatch({ type: 'agent_event', event });
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(errorText(error), 'error');
    } finally {
      dispatch({ type: 'set_running', running: false });
      abortRef.current = null;
    }
  }, [runtime, approvalHandler, notify]);

  const runChat = useCallback(async (prompt: string, extraContext: string[] = []) => {
    cancelChatRef.current = false;
    const current = stateRef.current;
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) dispatch({ type: 'set_session', sessionId });
    const userContext = [...extraContext, ...pendingContextRef.current];
    pendingContextRef.current = [];
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    dispatch({ type: 'set_running', running: true });
    dispatch({ type: 'set_activity', activity: 'thinking' });
    try {
      for await (const chunk of runtime.stream({
        prompt,
        profile: current.profile,
        provider: current.provider,
        model: current.model,
        sessionId,
        think: thinkRef.current,
        userContext: userContext.length > 0 ? userContext : undefined,
        images: images.length > 0 ? images : undefined,
      })) {
        if (cancelChatRef.current) break;
        dispatch({ type: 'assistant_delta', text: chunk });
      }
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      dispatch({ type: 'end_assistant' });
      dispatch({ type: 'set_running', running: false });
    }
  }, [runtime, notify]);

  const startTextRun = useCallback((text: string) => {
    dispatch({ type: 'add_user', text });
    if (stateRef.current.mode === 'chat') void runChat(text);
    else void runAgent(text);
  }, [runAgent, runChat]);

  const stop = useCallback(() => {
    cancelChatRef.current = true;
    abortRef.current?.abort();
    const resolve = approvalResolverRef.current;
    if (resolve) {
      approvalResolverRef.current = null;
      dispatch({ type: 'set_approval', request: undefined });
      resolve({ approved: false, reason: 'cancelled' });
    }
    if (stateRef.current.running) notify('Cancelling…', 'warn');
  }, [notify]);

  // --- Skills --------------------------------------------------------------
  const startSkillRun = useCallback((skill: MarifoldSkill, prompt: string) => {
    dispatch({ type: 'add_user', text: `$${skill.name}` });
    if (skill.mode === 'chat') void runChat(prompt);
    else void runAgent(prompt);
  }, [runAgent, runChat]);

  const runSkill = useCallback((name: string, argv: string[]) => {
    let skill: MarifoldSkill | undefined;
    try {
      skill = runtime.getSkill(name, stateRef.current.profile);
    } catch (error) {
      notify(errorText(error), 'error');
      return;
    }
    if (!skill) {
      notify(`Unknown skill: $${name}. Use /skills to list installed skills.`, 'warn');
      return;
    }
    const supplied = bindSkillArgs(skill, argv);
    const { prompt, missing } = renderSkillPrompt(skill, supplied);
    if (missing.length > 0) {
      setPendingSkill({ skill, supplied, missing, index: 0 });
      notify(`${skillUsage(skill)} — enter ${missing[0]}:`, 'info');
      return;
    }
    startSkillRun(skill, prompt);
  }, [runtime, notify, startSkillRun]);

  const fillSkillVariable = useCallback((value: string) => {
    setPendingSkill(current => {
      if (!current) return null;
      const supplied = { ...current.supplied, [current.missing[current.index]]: value };
      const nextIndex = current.index + 1;
      if (nextIndex < current.missing.length) {
        notify(`Enter ${current.missing[nextIndex]}:`, 'info');
        return { ...current, supplied, index: nextIndex };
      }
      const { prompt, missing } = renderSkillPrompt(current.skill, supplied);
      if (missing.length > 0) {
        notify(`Missing values for: ${missing.join(', ')}`, 'warn');
        return null;
      }
      startSkillRun(current.skill, prompt);
      return null;
    });
  }, [notify, startSkillRun]);

  // --- Overlays ------------------------------------------------------------
  const openModelPicker = useCallback(() => {
    const items = loadedConfig.config.models.options.map(option => ({ label: option, value: option }));
    setOverlay({ type: 'model', items });
  }, [loadedConfig]);

  const openProfilePicker = useCallback(() => {
    const items = runtime.listProfiles().map(profile => ({ label: profile.name, value: profile.name }));
    setOverlay({ type: 'profile', items });
  }, [runtime]);

  const openSkills = useCallback(() => {
    const items = runtime.listSkills(stateRef.current.profile).map(skill => ({
      label: skill.name,
      value: skill.name,
      hint: skill.description,
    }));
    setOverlay({ type: 'skills', items });
  }, [runtime]);

  const showSessions = useCallback(() => {
    const items = runtime.listSessions(20, stateRef.current.profile).map(session => ({
      label: session.id,
      value: session.id,
      hint: `${session.turnCount} turns`,
    }));
    setOverlay({ type: 'sessions', items });
  }, [runtime]);

  const showHelp = useCallback(() => {
    const lines = [
      'Plain text → talk to the agent (or chat in /chat mode).',
      '$<skill> [args] → run a model-backed skill.',
      '',
      ...listCommands().map(spec => `/${spec.name}${spec.aliases ? ` (/${spec.aliases.join(', /')})` : ''} — ${spec.summary}`),
    ];
    setOverlay({ type: 'info', title: 'Help', lines });
  }, []);

  const showPermissions = useCallback(() => {
    const approval = resolveAgentConfig(loadedConfig.config.agent).approval;
    const grants = [...sessionGrantsRef.current];
    const lines = [
      'Approval modes (config):',
      ...Object.entries(approval).map(([kind, mode]) => `  ${kind}: ${mode}`),
      '',
      `Session grants: ${grants.length ? grants.join(', ') : '(none)'}`,
      '',
      'Escalated calls (e.g. writes outside the working dir) always prompt.',
    ];
    setOverlay({ type: 'info', title: 'Permissions', lines });
  }, [loadedConfig]);

  const runDoctor = useCallback(() => {
    const current = stateRef.current;
    const provider = loadedConfig.config.providers[current.provider];
    const lines = [
      `Provider: ${current.provider}`,
      `Model: ${current.model}`,
      `Type: ${provider?.type ?? 'unknown'}`,
      `Base URL: ${provider?.baseUrl ?? '(default)'}`,
      `API key env: ${provider?.apiKeyEnv ?? '(none)'}${
        provider?.apiKeyEnv ? (process.env[provider.apiKeyEnv] ? ' ✓ set' : ' ✗ unset') : ''
      }`,
      `Stored key: ${provider?.apiKey ? 'present' : 'none'}`,
      '',
      'Run `marifold model` for full provider checks.',
    ];
    setOverlay({ type: 'info', title: 'Doctor', lines });
  }, [loadedConfig]);

  const installSkill = useCallback((arg: string) => {
    const run = async () => {
      try {
        let installed;
        if (/^https?:\/\//i.test(arg)) {
          const response = await fetch(arg);
          if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${arg}`);
          installed = runtime.installSkillFromText(await response.text());
        } else {
          installed = runtime.installSkillFromFile(path.resolve(expandHome(arg)));
        }
        refreshSkills();
        notify(`Installed skill: $${installed.name}`, 'info');
      } catch (error) {
        notify(`Install failed: ${errorText(error)}`, 'error');
      }
    };
    void run();
  }, [runtime, notify, refreshSkills]);

  const search = useCallback(async (query: string) => {
    notify(`Searching the web: ${query}`, 'info');
    try {
      const results = await runtime.searchWeb(query);
      dispatch({ type: 'add_user', text: `/search ${query}` });
      await runChat(query, [formatSearchContext(results)]);
    } catch (error) {
      notify(`Web search failed: ${errorText(error)}`, 'error');
    }
  }, [runtime, runChat, notify]);

  const readFileCmd = useCallback((file: string) => {
    try {
      const resolved = path.resolve(expandHome(file));
      const content = fs.readFileSync(resolved, 'utf-8');
      const truncated = content.length > READ_FILE_CHAR_LIMIT;
      const body = truncated
        ? `${content.slice(0, READ_FILE_CHAR_LIMIT)}\n[truncated at ${READ_FILE_CHAR_LIMIT} characters]`
        : content;
      pendingContextRef.current.push(`## File: ${resolved}\n\n${body}`);
      notify(`Attached ${resolved} (${content.length} chars) to your next message.`, 'info');
    } catch (error) {
      notify(`Could not read ${file}: ${errorText(error)}`, 'error');
    }
  }, [notify]);

  const setImage = useCallback((arg: string) => {
    if (arg === '' || arg.toLowerCase() === 'clear') {
      pendingImagesRef.current = [];
      notify('Cleared pending images.', 'info');
      return;
    }
    const resolved = path.resolve(expandHome(arg));
    if (!fs.existsSync(resolved)) {
      notify(`Image not found: ${resolved}`, 'error');
      return;
    }
    pendingImagesRef.current.push({ path: resolved });
    notify(`Attached image #${pendingImagesRef.current.length}: ${resolved}`, 'info');
  }, [notify]);

  const remember = useCallback((text: string) => {
    const result = runtime.rememberMemory(stateRef.current.profile, 'auto_short', text, stateRef.current.sessionId);
    notify(`${result.created ? 'Remembered' : 'Already remembered'}: ${result.entry.id}`, 'info');
  }, [runtime, notify]);

  const forget = useCallback((query: string) => {
    const result = runtime.forgetMemories(stateRef.current.profile, query);
    notify(result.count === 0 ? 'No matching memories.' : `Forgot ${result.count} memory record(s).`, 'info');
  }, [runtime, notify]);

  const deleteMemory = useCallback((query: string) => {
    const result = runtime.deleteMemories(stateRef.current.profile, query);
    notify(result.count === 0 ? 'No matching memories.' : `Deleted ${result.count} memory record(s).`, 'info');
  }, [runtime, notify]);

  const steer = useCallback((text: string) => {
    if (stateRef.current.running) {
      steeringRef.current.push(text);
      setSteeringCount(count => count + 1);
      notify(`Queued steering: ${text}`, 'info');
    } else {
      startTextRun(text);
    }
  }, [notify, startTextRun]);

  // CommandContext bound to the live handlers.
  const commandContext = useMemo<CommandContext>(() => ({
    notify,
    setMode: (mode: Mode) => { dispatch({ type: 'set_mode', mode }); notify(`Mode: ${mode}`, 'info'); },
    newSession: () => { dispatch({ type: 'new_session', sessionId: undefined }); notify('Started a new session.', 'info'); },
    clear: () => dispatch({ type: 'clear' }),
    stop,
    steer,
    exit: () => { dispatch({ type: 'exit' }); exit(); },
    setThink: (on: boolean) => { setThink(on); notify(`Thinking ${on ? 'on' : 'off'}.`, 'info'); },
    openModelPicker,
    openProfilePicker,
    openSkills,
    showPermissions,
    showHelp,
    showSessions,
    runDoctor,
    installSkill,
    search: q => void search(q),
    readFile: readFileCmd,
    setImage,
    remember,
    forget,
    deleteMemory,
  }), [
    notify, stop, steer, exit, openModelPicker, openProfilePicker, openSkills,
    showPermissions, showHelp, showSessions, runDoctor, installSkill, search,
    readFileCmd, setImage, remember, forget, deleteMemory,
  ]);

  // --- Input routing -------------------------------------------------------
  const handleSubmit = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (pendingSkill) {
      if (trimmed.length === 0) return;
      fillSkillVariable(trimmed);
      return;
    }
    const parsed = parseInput(raw);
    if (parsed.kind !== 'empty') setHistory(entries => [...entries, trimmed]);
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'command':
        if (!runCommand(commandContext, parsed.name, parsed.args)) {
          notify(`Unknown command: /${parsed.name}. Type /help.`, 'warn');
        }
        return;
      case 'skill':
        if (stateRef.current.running) {
          notify('A task is running. Use /btw to steer or /stop to cancel.', 'warn');
          return;
        }
        runSkill(parsed.name, parsed.argv);
        return;
      case 'text':
        if (stateRef.current.running) {
          notify('A task is running. Use /btw to steer or /stop to cancel.', 'warn');
          return;
        }
        startTextRun(parsed.text);
        return;
    }
  }, [pendingSkill, fillSkillVariable, commandContext, notify, runSkill, startTextRun]);

  const handleInterrupt = useCallback((reason: 'ctrl-c' | 'escape') => {
    if (stateRef.current.running) {
      stop();
      return;
    }
    if (reason === 'ctrl-c') {
      // Require a second Ctrl+C within 1.5s to exit, so one stray press never
      // drops the session.
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1500) {
        dispatch({ type: 'exit' });
        exit();
      } else {
        lastCtrlCRef.current = now;
        notify('Press Ctrl+C again to exit.', 'info');
      }
    }
  }, [stop, exit, notify]);

  const onModelSelect = useCallback((value: string) => {
    setOverlay(null);
    const [provider, ...rest] = value.split('/');
    const model = rest.join('/');
    if (provider && model) {
      dispatch({ type: 'set_model', provider, model });
      notify(`Model: ${provider}/${model}`, 'info');
    }
  }, [notify]);

  const onProfileSelect = useCallback((value: string) => {
    setOverlay(null);
    try {
      const settings = runtime.resolveSettings({ profile: value });
      dispatch({ type: 'set_profile', profile: settings.profile, provider: settings.provider, model: settings.model });
      dispatch({ type: 'new_session', sessionId: undefined });
      sessionGrantsRef.current.clear();
      refreshSkills();
      notify(`Profile: ${settings.profile} (${settings.provider}/${settings.model})`, 'info');
    } catch (error) {
      notify(`Could not switch profile: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify, refreshSkills]);

  // --- Render --------------------------------------------------------------
  const activeOverlay = renderOverlay();

  function renderOverlay(): React.ReactElement | null {
    if (state.approval) {
      return <ApprovalModal request={state.approval} onResolve={resolveApproval} />;
    }
    if (!overlay) return null;
    if (overlay.type === 'info') {
      return <InfoPanel title={overlay.title} lines={overlay.lines} onClose={() => setOverlay(null)} />;
    }
    if (overlay.type === 'model') {
      return <SelectList title="Select model" items={overlay.items} onSelect={onModelSelect} onCancel={() => setOverlay(null)} />;
    }
    if (overlay.type === 'profile') {
      return <SelectList title="Select profile" items={overlay.items} onSelect={onProfileSelect} onCancel={() => setOverlay(null)} />;
    }
    if (overlay.type === 'sessions') {
      return (
        <SelectList
          title="Recent sessions"
          items={overlay.items}
          onSelect={value => {
            setOverlay(null);
            dispatch({ type: 'new_session', sessionId: value });
            const detail = runtime.getSession(value);
            for (const turn of detail?.turns ?? []) {
              dispatch({ type: 'add_item', item: { kind: turn.role === 'user' ? 'user' : 'assistant', text: turn.content } });
            }
            notify(`Resumed session ${value}`, 'info');
          }}
          onCancel={() => setOverlay(null)}
        />
      );
    }
    // skills
    return (
      <SelectList
        title="Skills — Enter runs, Del removes"
        items={overlay.items}
        onSelect={value => { setOverlay(null); runSkill(value, []); }}
        onCancel={() => setOverlay(null)}
        onDelete={value => {
          runtime.removeSkill(value, stateRef.current.profile);
          refreshSkills();
          notify(`Removed skill: $${value}`, 'info');
          openSkills();
        }}
      />
    );
  }

  // Committed transcript items go to <Static> (written once, into the
  // terminal's native scrollback). A still-streaming assistant item stays in
  // the live region until it ends, so the marifold bar, input, and status line
  // stay pinned at the bottom of the terminal while history scrolls above.
  const committed = state.streamingAssistant ? state.transcript.slice(0, -1) : state.transcript;
  const liveItem = state.streamingAssistant ? state.transcript[state.transcript.length - 1] : undefined;

  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {item => (
          <Box key={item.id} paddingX={1} marginBottom={item.kind === 'plan' ? 1 : 0}>
            <TranscriptRow item={item} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column">
        {liveItem ? (
          <Box paddingX={1}>
            <TranscriptRow item={liveItem} />
          </Box>
        ) : null}
        <Header state={state} />
        {activeOverlay ?? (
          <InputBox
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            history={history}
            commandNames={commandNames}
            skillNames={skillNames}
            placeholder={pendingSkill ? `value for ${pendingSkill.missing[pendingSkill.index]}` : state.mode === 'agent' ? 'message the agent · /help' : 'chat · /help'}
          />
        )}
        <StatusLine state={state} steeringQueued={steeringCount} />
      </Box>
    </Box>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
