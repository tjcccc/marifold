import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, useApp, useInput, useStdout } from 'ink';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  expandHome,
  isInsideAny,
  renderSkillPrompt,
} from '@marifold/core';
import type {
  AgentUsage,
  ApprovalDecision,
  ApprovalRequest,
  ImageInput,
  LoadedMarifoldConfig,
  MarifoldRuntime,
  MarifoldSkill,
  ToolKind,
} from '@marifold/core';
import { appReducer, createInitialState, type Mode, type NoticeTone, type TranscriptItem, type TranscriptItemData } from '../core/appState.js';
import { parseInput } from '../core/inputGrammar.js';
import { listCommands, runCommand, type CommandContext } from '../core/commands.js';
import { bindSkillArgs, skillUsage } from '../core/skills.js';
import { Header } from './Header.js';
import { TranscriptRow, topGap } from './Transcript.js';
import { InputBox, type CompletionItem } from './InputBox.js';
import { StatusLine } from './StatusLine.js';
import { RunStatus } from './RunStatus.js';
import { ApprovalModal, trustTargetFolder, type ApprovalChoice } from './ApprovalModal.js';
import { SelectList, type SelectItem } from './SelectList.js';
import { useTerminalSize } from './useTerminalSize.js';
import { useResizing } from './useResizing.js';
import { copyToClipboard, errorText, runSummary, skillInvocation, unwrapPath } from './appHelpers.js';

const READ_FILE_CHAR_LIMIT = 100000;

export interface AppProps {
  runtime: MarifoldRuntime;
  loadedConfig: LoadedMarifoldConfig;
  initial: {
    profile: string;
    provider: string;
    model: string;
    think: boolean;
    mode?: Mode;
    cwd: string;
    version: string;
    latestVersion?: string;
    sessionId?: string;
    maxContextTokens?: number;
    transcript?: TranscriptItemData[];
  };
}

type SkillScope = 'global' | 'profile';
type Overlay =
  | { type: 'model' | 'profile' | 'sessions'; items: SelectItem[] }
  | { type: 'skills'; scope: SkillScope; items: SelectItem[]; title: string; emptyHint: string[] };

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
    createInitialState({
      profile: initial.profile,
      provider: initial.provider,
      model: initial.model,
      cwd: initial.cwd,
      version: initial.version,
      ...(initial.mode ? { mode: initial.mode } : {}),
      ...(initial.latestVersion ? { latestVersion: initial.latestVersion } : {}),
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
      ...(initial.maxContextTokens != null ? { maxContextTokens: initial.maxContextTokens } : {}),
      ...(initial.transcript ? { transcript: initial.transcript } : {}),
    }),
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [think, setThink] = useState(initial.think);
  // `/steps` arms a one-shot forced plan for the next model turn (then auto-disarms).
  const [planNext, setPlanNext] = useState(false);
  const [steeringCount, setSteeringCount] = useState(0);
  const [pendingSkill, setPendingSkill] = useState<PendingSkill | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [skillItems, setSkillItems] = useState<CompletionItem[]>(() => {
    try {
      return runtime.listSkills(initial.profile).map(skill => ({ name: skill.name, hint: skill.description }));
    } catch {
      return [];
    }
  });
  const commandItems = useMemo<CompletionItem[]>(
    () => listCommands().map(spec => ({ name: spec.name, hint: spec.summary })),
    [],
  );
  // Used to cap overlay (picker) height between the latest content and the input.
  const { rows } = useTerminalSize();
  // While the terminal is actively resizing, the live region collapses to a
  // single line so Ink's erase math can't desync and duplicate the input.
  const resizing = useResizing();

  // A full clean repaint — bound to Ctrl+L, and fired once when a resize
  // settles — to clear lines the terminal stranded while reflowing scrollback
  // mid-resize. We clear the screen, then bump the <Static> key so Ink re-emits
  // the whole committed transcript from the top (its `handleStaticChange` resets
  // the cached static output). Nothing is lost: the banner and every turn are
  // reprinted clean.
  const { stdout } = useStdout();
  const [staticEpoch, setStaticEpoch] = useState(0);
  const wasResizing = useRef(false);
  const repaint = useCallback(() => {
    (stdout ?? process.stdout).write('\x1b[2J\x1b[3J\x1b[H');
    setStaticEpoch(epoch => epoch + 1);
  }, [stdout]);
  useEffect(() => {
    if (wasResizing.current && !resizing) repaint();
    wasResizing.current = resizing;
  }, [resizing, repaint]);
  // Anchor the run clock here so it survives RunStatus unmounting during a
  // resize burst (`!resizing && state.running` below). If RunStatus owned the
  // start time, remounting after the resize settled would restart it at 0.
  const runStartedAt = useRef(0);
  if (state.running) {
    if (runStartedAt.current === 0) runStartedAt.current = Date.now();
  } else {
    runStartedAt.current = 0;
  }
  // Ctrl+L forces a clean repaint. Inactive while an overlay/modal owns input,
  // so it never competes with the picker's or approval modal's key handling.
  useInput((input, key) => {
    if (key.ctrl && input === 'l') repaint();
  }, { isActive: !overlay && !state.approval });

  // The committed transcript lives in Ink's <Static>, which is append-only and
  // cannot un-render. So whenever items are removed/reset (a /new, /clear,
  // profile switch, or session resume) rather than just appended, force a clean
  // repaint so the screen reflects the new transcript instead of stale rows.
  const prevItemIds = useRef<string[]>([]);
  useEffect(() => {
    const ids = state.transcript.map(item => item.id);
    const appendedOnly = prevItemIds.current.every((id, index) => ids[index] === id);
    prevItemIds.current = ids;
    if (!appendedOnly) repaint();
  }, [state.transcript, repaint]);

  // Mutable run plumbing (does not drive rendering directly).
  const abortRef = useRef<AbortController | null>(null);
  const approvalResolverRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const sessionGrantsRef = useRef<Set<ToolKind>>(new Set());
  const sessionTrustedFoldersRef = useRef<Set<string>>(new Set());
  const steeringRef = useRef<string[]>([]);
  const pendingContextRef = useRef<string[]>([]);
  const pendingImagesRef = useRef<ImageInput[]>([]);
  const lastCtrlCRef = useRef(0);

  // Latest state for callbacks that must read current values without re-binding.
  const stateRef = useRef(state);
  stateRef.current = state;
  const thinkRef = useRef(think);
  thinkRef.current = think;
  const planNextRef = useRef(planNext);
  planNextRef.current = planNext;
  // Last plain-text prompt, for `/retry`.
  const lastPromptRef = useRef<string | null>(null);

  // Exit: the conversation already lives in the terminal's native scrollback
  // (inline layout), so there's nothing to reprint — just unmount.
  const quit = useCallback(() => {
    dispatch({ type: 'exit' });
    exit();
  }, [exit]);

  const notify = useCallback((text: string, tone: NoticeTone = 'info') => {
    dispatch({ type: 'notice', tone, text });
  }, []);

  // Confirm a `--resume` launch with a notice below the replayed turns, so the
  // boundary between prior history and the current session is clear.
  const resumeNoticeShown = useRef(false);
  useEffect(() => {
    if (resumeNoticeShown.current) return;
    resumeNoticeShown.current = true;
    if (initial.sessionId) {
      notify(`Resumed session ${initial.sessionId.slice(0, 8)} — your next message continues it.`, 'info');
    }
  }, [notify, initial.sessionId]);

  const refreshSkills = useCallback(() => {
    try {
      setSkillItems(runtime.listSkills(stateRef.current.profile).map(skill => ({ name: skill.name, hint: skill.description })));
    } catch {
      setSkillItems([]);
    }
  }, [runtime]);

  // --- Approvals -----------------------------------------------------------
  const approvalHandler = useCallback((request: ApprovalRequest): Promise<ApprovalDecision> => {
    // Auto-approve from this session's "Always" grants — the run's baked config
    // can't see them, so the App layer applies them: a kind grant for ordinary
    // calls, a trusted folder for escalated writes inside it.
    if (!request.escalated && sessionGrantsRef.current.has(request.kind)) {
      return Promise.resolve({ approved: true });
    }
    if (request.escalated && request.escalatedPath
        && isInsideAny(request.escalatedPath, [...sessionTrustedFoldersRef.current])) {
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
    if (choice === 'no') {
      resolve({ approved: false, reason: 'denied by user' });
      return;
    }
    if (choice === 'always') {
      const folder = trustTargetFolder(request);
      if (folder) trustFolderForProfile(folder);   // escalated write → trust the folder
      else persistApprovalKind(request.kind);       // ordinary call → allow this kind
    }
    resolve({ approved: true });
  }, []);

  // "Always (allow <kind>)": persist to the active profile + grant for this session.
  const persistApprovalKind = useCallback((kind: ToolKind) => {
    const profile = stateRef.current.profile;
    sessionGrantsRef.current.add(kind);
    try {
      runtime.setProfileAgentApproval(profile, kind, 'allow');
      notify(`Persisted approval: ${kind} = allow for ${profile}`, 'info');
    } catch (error) {
      notify(`Could not persist approval: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify]);

  // "Always (trust <folder>)" / `/trust-folder`: persist to the active profile +
  // trust for this session (the running run can't re-read profile.toml).
  const trustFolderForProfile = useCallback((folder: string) => {
    const profile = stateRef.current.profile;
    try {
      const resolved = runtime.addProfileTrustedFolder(profile, folder);
      sessionTrustedFoldersRef.current.add(resolved);
      notify(`Trusting ${resolved} for ${profile} (writes here won't ask).`, 'info');
    } catch (error) {
      notify(`Could not trust folder: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify]);

  // --- Runs ----------------------------------------------------------------
  const runAgent = useCallback(async (objective: string, options: { instructions?: string[]; userTurn?: string; lean?: boolean; forcePlan?: boolean } = {}) => {
    const controller = new AbortController();
    abortRef.current = controller;
    steeringRef.current = [];
    setSteeringCount(0);
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    const current = stateRef.current;
    // One conversation session shared with chat mode, so the agent remembers
    // earlier turns. Skills pass their body via `instructions` (authoritative,
    // not persisted) rather than isolating, so context-aware skills still see
    // the conversation.
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) dispatch({ type: 'set_session', sessionId });
    dispatch({ type: 'set_running', running: true });
    const startedAt = Date.now();
    let usage: AgentUsage | undefined;
    let doneStatus: string | undefined;
    try {
      const runner = runtime.createAgentRunner(current.profile);
      for await (const event of runner.run({
        objective,
        profile: current.profile,
        provider: current.provider,
        model: current.model,
        sessionId,
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.userTurn ? { userTurn: options.userTurn } : {}),
        ...(options.lean ? { lean: true } : {}),
        ...(options.forcePlan ? { forcePlan: true } : {}),
        ...(images.length > 0 ? { images } : {}),
        signal: controller.signal,
        approvalHandler,
        steering: () => {
          const queued = steeringRef.current;
          steeringRef.current = [];
          setSteeringCount(0);
          return queued;
        },
      })) {
        if (event.type === 'done') {
          usage = event.usage;
          doneStatus = event.status;
        }
        dispatch({ type: 'agent_event', event });
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(errorText(error), 'error');
    } finally {
      dispatch({ type: 'set_running', running: false });
      abortRef.current = null;
      if (usage?.inputTokens != null) dispatch({ type: 'set_context_usage', tokens: usage.inputTokens });
      if (controller.signal.aborted) {
        notify('Cancelled.', 'warn');
      } else {
        const status = doneStatus ?? 'ended';
        notify(`Task ${status}. ${runSummary(Date.now() - startedAt, usage)}`, status === 'completed' ? 'info' : 'warn');
      }
    }
  }, [runtime, approvalHandler, notify]);

  const runChat = useCallback(async (prompt: string, extraContext: string[] = [], options: { instructions?: string[] } = {}) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const current = stateRef.current;
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) dispatch({ type: 'set_session', sessionId });
    const userContext = [...extraContext, ...pendingContextRef.current];
    pendingContextRef.current = [];
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    dispatch({ type: 'set_running', running: true });
    dispatch({ type: 'set_activity', activity: 'thinking' });
    const startedAt = Date.now();
    let usage: AgentUsage | undefined;
    try {
      for await (const chunk of runtime.stream(
        {
          prompt,
          profile: current.profile,
          provider: current.provider,
          model: current.model,
          sessionId,
          think: thinkRef.current,
          ...(current.maxContextTokens != null ? { maxContextTokens: current.maxContextTokens } : {}),
          userContext: userContext.length > 0 ? userContext : undefined,
          ...(options.instructions ? { instructions: options.instructions } : {}),
          images: images.length > 0 ? images : undefined,
          signal: controller.signal,
        },
        summary => { usage = summary.usage; },
      )) {
        if (controller.signal.aborted) break;
        dispatch({ type: 'assistant_delta', text: chunk });
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(errorText(error), 'error');
    } finally {
      dispatch({ type: 'end_assistant' });
      dispatch({ type: 'set_running', running: false });
      abortRef.current = null;
      if (usage?.inputTokens != null) dispatch({ type: 'set_context_usage', tokens: usage.inputTokens });
      if (controller.signal.aborted) notify('Cancelled.', 'warn');
      else notify(runSummary(Date.now() - startedAt, usage), 'info');
    }
  }, [runtime, notify]);

  const startTextRun = useCallback((text: string) => {
    // Remember the last plain-text prompt so `/retry` can re-run it. Captured
    // here (the sole text-run entry) rather than read from the transcript, which
    // also records `/command` and `$skill` echoes as user items.
    lastPromptRef.current = text;
    dispatch({ type: 'add_user', text });
    // `/steps` armed: run this turn as a planned agent turn (planning is an agent
    // concept), then auto-disarm.
    if (planNextRef.current) {
      setPlanNext(false);
      void runAgent(text, { forcePlan: true });
      return;
    }
    if (stateRef.current.mode === 'chat') void runChat(text);
    else void runAgent(text);
  }, [runAgent, runChat]);

  // Re-run the last plain-text message through the current profile/model/mode —
  // handy for A/B-ing models (switch with /model, then /retry). Appends a new
  // turn; does not re-invoke a `$skill` or re-attach prior images/context.
  const retryLast = useCallback(() => {
    if (stateRef.current.running) {
      notify('A task is running. Use /btw to steer or /stop to cancel.', 'warn');
      return;
    }
    const last = lastPromptRef.current;
    if (!last) {
      notify('Nothing to retry yet — send a message first.', 'warn');
      return;
    }
    startTextRun(last);
  }, [notify, startTextRun]);

  const stop = useCallback(() => {
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
  const startSkillRun = useCallback((skill: MarifoldSkill, body: string, userInput: string, displayText: string) => {
    dispatch({ type: 'add_user', text: displayText });
    // Codex/Claude-style: the skill body is authoritative instructions (sent via
    // `instructions`, top of the system prompt), and the user's typed input is
    // the turn the model acts on — so input is never dropped and the skill is not
    // polluted by prior turns, without isolating it from the conversation.
    const prompt = userInput.trim() || 'Follow the skill instructions above and produce the output.';
    // `/steps` armed: force a planned agent run for this skill (then disarm).
    const forcePlan = planNextRef.current;
    if (forcePlan) setPlanNext(false);
    // An undeclared mode follows the session: a skill invoked in an agent session
    // runs agentically (with tools), so it can read its own bundled files. A
    // forced plan always runs as an agent (planning needs the agent loop).
    const mode = forcePlan ? 'agent' : (skill.mode ?? stateRef.current.mode);
    if (mode === 'chat') {
      void runChat(prompt, [], { instructions: [body] });
    } else {
      // Tell the agent where the skill's bundled files live so it can read them
      // (e.g. a vars.toml of `#name` fragments) with read_file, as the skill
      // instructions direct — the agentic-tool model, like Codex/Claude.
      const dir = skill.source?.replace(/\/SKILL\.md$/, '');
      const instructions = dir
        ? [body, `This skill's bundled files are in ${dir}. When the instructions reference files such as vars.toml, read them from there with read_file.`]
        : [body];
      // Persist the invocation the user typed (e.g. `$make-… #photo1 …`) as the
      // resumable user turn, not the agent's internal objective. `lean` skips the
      // plan/verify phases and verbose framing — a skill is a single transform,
      // so that's pure token overhead.
      void runAgent(prompt, { instructions, userTurn: displayText, lean: true, ...(forcePlan ? { forcePlan: true } : {}) });
    }
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
    startSkillRun(skill, prompt, argv.join(' '), skillInvocation(name, argv));
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
      const args = current.skill.variables
        .map(variable => supplied[variable.name])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      startSkillRun(current.skill, prompt, args.join(' '), skillInvocation(current.skill.name, args));
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

  const openSkills = useCallback((scope: SkillScope = 'profile') => {
    const profile = stateRef.current.profile;
    const items = runtime.listSkills(profile, scope).map(skill => ({
      label: skill.name,
      value: skill.name,
      hint: skill.description,
    }));
    // Cross-reference the other layer so global skills stay discoverable from
    // the profile view (and vice versa).
    const other: SkillScope = scope === 'global' ? 'profile' : 'global';
    const otherCount = runtime.listSkills(profile, other).length;
    const otherCmd = other === 'global' ? '/skills --global' : '/skills';
    const base = scope === 'global' ? 'Global skills' : 'Profile skills';
    const title = `${base} — Enter runs, Del removes${otherCount ? `  (+${otherCount} ${other}: ${otherCmd})` : ''}`;
    const emptyHint = scope === 'global'
      ? ['/install-skill --global <path>  installs a global skill (all profiles)']
      : ['/install-skill <path>  installs a skill into this profile'];
    if (otherCount) emptyHint.push(`${otherCount} ${other} skill(s) — ${otherCmd}`);
    setOverlay({ type: 'skills', scope, items, title, emptyHint });
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
    dispatch({ type: 'add_item', item: { kind: 'info', title: 'Help', lines } });
  }, []);

  const showStatus = useCallback(() => {
    const s = stateRef.current;
    const userTurns = s.transcript.filter(item => item.kind === 'user').length;
    const session = s.sessionId ?? '(starts on your first message)';
    const lines = [
      `Profile:    ${s.profile}`,
      `Mode:       ${s.mode}`,
      `Provider:   ${s.provider}`,
      `Model:      ${s.model}`,
      `Thinking:   ${thinkRef.current ? 'on' : 'off'}`,
      `Session:    ${session}`,
      `Turns:      ${userTurns}`,
      `Directory:  ${s.cwd}`,
      `Version:    ${s.version}`,
    ];
    dispatch({ type: 'add_item', item: { kind: 'info', title: 'Status', lines } });
  }, []);

  const copyLast = useCallback(() => {
    const last = [...stateRef.current.transcript].reverse().find(item => item.kind === 'assistant');
    if (!last || last.kind !== 'assistant') {
      notify('No response to copy yet.', 'warn');
      return;
    }
    copyToClipboard(last.text)
      .then(() => notify(`Copied the last response (${last.text.length} chars) to the clipboard.`, 'info'))
      .catch(error => notify(`Copy failed: ${errorText(error)}`, 'error'));
  }, [notify]);

  const showPermissions = useCallback(() => {
    const profile = stateRef.current.profile;
    const agent = runtime.resolveAgentConfigForProfile(profile);
    const grants = [...sessionGrantsRef.current];
    const sessionTrusted = [...sessionTrustedFoldersRef.current];
    const lines = [
      `Approval modes (profile ${profile}):`,
      ...Object.entries(agent.approval).map(([kind, mode]) => `  ${kind}: ${mode}`),
      '',
      `Trusted folders: ${agent.trustedFolders.length ? agent.trustedFolders.join(', ') : '(none)'}`,
      `Session grants: ${grants.length ? grants.join(', ') : '(none)'}`,
      ...(sessionTrusted.length ? [`Trusted this session: ${sessionTrusted.join(', ')}`] : []),
      '',
      'Writes outside the working dir and trusted folders prompt (Once / Always / No).',
    ];
    dispatch({ type: 'add_item', item: { kind: 'info', title: 'Permissions', lines } });
  }, [runtime]);

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
    dispatch({ type: 'add_item', item: { kind: 'info', title: 'Doctor', lines } });
  }, [loadedConfig]);

  const installSkill = useCallback((arg: string) => {
    // `--global` installs for every profile; otherwise the skill lands in the
    // current profile (profile skills shadow global ones).
    const tokens = arg.trim().split(/\s+/).filter(Boolean);
    const global = tokens.includes('--global');
    const target = unwrapPath(tokens.filter(token => token !== '--global').join(' '));
    const scope = global ? 'global' : 'profile';
    const profile = stateRef.current.profile;
    const run = async () => {
      try {
        if (!target) {
          notify('Usage: /install-skill [--global] <path|url>', 'warn');
          return;
        }
        let installed;
        if (/^https?:\/\//i.test(target)) {
          const response = await fetch(target);
          if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${target}`);
          installed = runtime.installSkillFromText(await response.text(), scope, profile);
        } else {
          installed = runtime.installSkillFromFile(path.resolve(expandHome(target)), scope, profile);
        }
        refreshSkills();
        notify(`Installed skill: $${installed.name} (${global ? 'global' : `profile ${profile}`})`, 'info');
      } catch (error) {
        notify(`Install failed: ${errorText(error)}`, 'error');
      }
    };
    void run();
  }, [runtime, notify, refreshSkills]);

  const readFileCmd = useCallback((file: string) => {
    try {
      const resolved = path.resolve(expandHome(unwrapPath(file)));
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
    const resolved = path.resolve(expandHome(unwrapPath(arg)));
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
    // Steering only has meaning inside the agent loop; chat is a single-turn
    // request that never reads the steering queue, so a `/btw` there would be
    // silently dropped. Reject it with a clear message instead.
    if (stateRef.current.mode === 'chat') {
      notify('/btw (steering) only applies in agent mode.', 'warn');
      return;
    }
    if (stateRef.current.running) {
      steeringRef.current.push(text);
      setSteeringCount(count => count + 1);
      notify(`Queued steering: ${text}`, 'info');
    } else {
      startTextRun(text);
    }
  }, [notify, startTextRun]);

  // Switch profile (from `/profile <name>` or the picker): starts a fresh
  // session and confirms in the transcript.
  const selectProfile = useCallback((value: string) => {
    setOverlay(null);
    try {
      const settings = runtime.resolveSettings({ profile: value });
      dispatch({
        type: 'set_profile',
        profile: settings.profile,
        provider: settings.provider,
        model: settings.model,
        maxContextTokens: settings.maxContextTokens ?? loadedConfig.config.default.maxContextTokens,
      });
      dispatch({ type: 'set_mode', mode: settings.mode });
      // Adopt the new profile's thinking default (bare setter — selectProfile
      // emits its own notice; the wrapped ctx.setThink would add a spurious one).
      setThink(settings.think);
      dispatch({ type: 'new_session', sessionId: undefined });
      sessionGrantsRef.current.clear();
      sessionTrustedFoldersRef.current.clear();
      refreshSkills();
      notify(`Switched to profile: ${settings.profile} · ${settings.provider}/${settings.model} · ${settings.mode} (new session)`, 'info');
    } catch (error) {
      notify(`Could not switch profile: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify, refreshSkills]);

  // CommandContext bound to the live handlers.
  const commandContext = useMemo<CommandContext>(() => ({
    notify,
    // The Header (mode shown) lives in the append-only <Static>, so a mode
    // change needs a repaint to refresh it — otherwise the top line goes stale
    // while the live StatusLine flips. repaint() remounts Static with the new mode.
    setMode: (mode: Mode) => { dispatch({ type: 'set_mode', mode }); notify(`Mode: ${mode}`, 'info'); repaint(); },
    setDefaultMode: (mode: Mode) => {
      try {
        runtime.setProfileMode(stateRef.current.profile, mode);
        dispatch({ type: 'set_mode', mode });
        notify(`Default mode for ${stateRef.current.profile} set to ${mode} (this and future sessions).`, 'info');
        repaint();
      } catch (error) {
        notify(`Could not set default mode: ${errorText(error)}`, 'error');
      }
    },
    newSession: () => { dispatch({ type: 'new_session', sessionId: undefined }); notify('Started a new session.', 'info'); },
    clear: () => dispatch({ type: 'clear' }),
    stop,
    steer,
    exit: quit,
    setThink: (on: boolean) => { setThink(on); notify(`Thinking ${on ? 'on' : 'off'}.`, 'info'); },
    toggleForcePlan: () => setPlanNext(armed => {
      notify(armed ? 'Planning disarmed.' : 'Next message will be planned step-by-step.', 'info');
      return !armed;
    }),
    openModelPicker,
    openProfilePicker,
    selectProfile,
    openSkills,
    showPermissions,
    showHelp,
    showStatus,
    copyLast,
    retryLast,
    showSessions,
    runDoctor,
    installSkill,
    readFile: readFileCmd,
    setImage,
    remember,
    forget,
    deleteMemory,
    showContextWindow: () => {
      const s = stateRef.current;
      if (s.maxContextTokens == null || s.maxContextTokens <= 0) {
        notify('Context budget: off (compaction disabled). Enable with /context-window set <tokens>.', 'info');
        return;
      }
      const used = s.contextTokens;
      const pct = used != null ? ` · using ${used.toLocaleString()} (${Math.round((used / s.maxContextTokens) * 100)}%)` : ' · no turn measured yet';
      notify(`Context budget: ${s.maxContextTokens.toLocaleString()} tokens${pct}. Compacts past ~80%.`, 'info');
    },
    setContextWindow: (tokens?: number) => {
      dispatch({ type: 'set_context_budget', maxContextTokens: tokens });
      notify(tokens ? `Context budget set to ${tokens.toLocaleString()} tokens for this session.` : 'Compaction disabled for this session.', 'info');
    },
    setDefaultContextWindow: (tokens?: number) => {
      try {
        const saved = runtime.setProfileMaxContextTokens(stateRef.current.profile, tokens);
        dispatch({ type: 'set_context_budget', maxContextTokens: saved });
        notify(saved
          ? `Default context budget for ${stateRef.current.profile} set to ${saved.toLocaleString()} tokens (this and future sessions).`
          : `Compaction disabled by default for ${stateRef.current.profile}.`, 'info');
      } catch (error) {
        notify(`Could not set default context budget: ${errorText(error)}`, 'error');
      }
    },
    compactNow: () => {
      const s = stateRef.current;
      if (!s.sessionId) { notify('No active session to compact yet — send a message first.', 'warn'); return; }
      if (s.maxContextTokens == null) { notify('Set a context budget first: /context-window set <tokens>.', 'warn'); return; }
      notify('Compacting context…', 'info');
      runtime.compactSession(s.sessionId, {
        profile: s.profile, provider: s.provider, model: s.model, think: thinkRef.current, maxContextTokens: s.maxContextTokens,
      }).then(result => {
        notify(result.compacted ? 'Context compacted — older turns folded into a summary.' : 'Nothing to compact yet (history fits within the kept tail).', 'info');
      }).catch(error => notify(`Compaction failed: ${errorText(error)}`, 'error'));
    },
    trustFolder: trustFolderForProfile,
  }), [
    notify, stop, steer, exit, openModelPicker, openProfilePicker, selectProfile, openSkills,
    showPermissions, showHelp, showStatus, copyLast, retryLast, showSessions, runDoctor, installSkill,
    readFileCmd, setImage, remember, forget, deleteMemory, repaint, runtime, trustFolderForProfile,
  ]);

  // --- Input routing -------------------------------------------------------
  const handleSubmit = useCallback((raw: string, attachedImages: string[] = []) => {
    const trimmed = raw.trim();
    if (pendingSkill) {
      if (trimmed.length === 0) return;
      fillSkillVariable(trimmed);
      return;
    }
    const parsed = parseInput(raw);
    // Dropped images (`[image #n]` tokens) attach to the message about to run.
    // Both the chat path (runChat) and the agent path (runAgent) consume
    // pendingImagesRef, so this works in either mode for a text/skill turn.
    if (attachedImages.length > 0) {
      if (parsed.kind === 'text' || parsed.kind === 'skill') {
        for (const file of attachedImages) pendingImagesRef.current.push({ path: file });
      } else {
        notify(`Images attach to a message, not /${parsed.kind === 'command' ? 'commands' : 'input'}. Ignored ${attachedImages.length} image(s).`, 'warn');
      }
    }
    if (parsed.kind !== 'empty') setHistory(entries => [...entries, trimmed]);
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'command':
        // Echo the command as a transcript divider (like a sent message) so its
        // result is clearly separated from the previous turn.
        dispatch({ type: 'add_user', text: trimmed });
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
        quit();
      } else {
        lastCtrlCRef.current = now;
        notify('Press Ctrl+C again to exit.', 'info');
      }
    }
  }, [stop, quit, notify]);

  const onModelSelect = useCallback((value: string) => {
    setOverlay(null);
    const [provider, ...rest] = value.split('/');
    const model = rest.join('/');
    if (provider && model) {
      dispatch({ type: 'set_model', provider, model });
      notify(`Model: ${provider}/${model}`, 'info');
    }
  }, [notify]);


  // --- Render --------------------------------------------------------------
  const activeOverlay = renderOverlay();

  function renderOverlay(): React.ReactElement | null {
    if (state.approval) {
      return <ApprovalModal request={state.approval} onResolve={resolveApproval} />;
    }
    if (!overlay) return null;
    // Cap overlay height so it fits between the banner and status line.
    const overlayMaxRows = Math.max(4, rows - 9);
    if (overlay.type === 'model') {
      return <SelectList title="Select model" items={overlay.items} onSelect={onModelSelect} onCancel={() => setOverlay(null)} maxRows={overlayMaxRows} />;
    }
    if (overlay.type === 'profile') {
      return <SelectList title="Select profile" items={overlay.items} onSelect={selectProfile} onCancel={() => setOverlay(null)} maxRows={overlayMaxRows} />;
    }
    if (overlay.type === 'sessions') {
      return (
        <SelectList
          title="Recent sessions"
          maxRows={overlayMaxRows}
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
    // skills (scope-aware: profile or global)
    if (overlay.type === 'skills') {
      const scope = overlay.scope;
      return (
        <SelectList
          title={overlay.title}
          maxRows={overlayMaxRows}
          items={overlay.items}
          emptyHint={overlay.emptyHint}
          onSelect={value => { setOverlay(null); runSkill(value, []); }}
          onCancel={() => setOverlay(null)}
          onDelete={value => {
            runtime.removeSkill(value, stateRef.current.profile, scope);
            refreshSkills();
            notify(`Removed ${scope} skill: $${value}`, 'info');
            openSkills(scope);
          }}
        />
      );
    }
    return null;
  }

  // Inline layout (Claude/Codex-style): the banner prints once at the top of the
  // terminal's native scrollback and the committed transcript appends below it,
  // so the whole conversation stays scrollable and copyable in the terminal — and
  // survives after exit. The run line, input, and status stay pinned just below
  // the latest content. A still-streaming assistant item renders in the live
  // region until it ends, so the bottom UI doesn't flicker mid-stream.
  //
  // Ink 7 clears its live region on width-decrease (its `resized` handler), so
  // the input/status don't duplicate on shrink. Committed history is left to the
  // terminal's own reflow — which we keep clean by holding the live region small
  // (the input box bounds its own height).
  const committed = state.streamingAssistant ? state.transcript.slice(0, -1) : state.transcript;
  const liveItem = state.streamingAssistant ? state.transcript[state.transcript.length - 1] : undefined;
  const staticItems: StaticEntry[] = [{ id: BANNER_ID }, ...committed];

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={staticItems}>
        {(item, index) => {
          if (!('kind' in item)) {
            // The banner (header) leads the scrollback; the next row's own top
            // gap separates it from the first turn.
            return (
              <Box key={item.id} marginTop={1}>
                <Header state={state} />
              </Box>
            );
          }
          const prev = staticItems[index - 1];
          const prevKind = prev && 'kind' in prev ? prev.kind : 'banner';
          return (
            <Box key={item.id} paddingX={1} marginTop={topGap(item.kind, prevKind)}>
              <TranscriptRow item={item} />
            </Box>
          );
        }}
      </Static>
      {/* A single blank separates the committed transcript from the live region
          (a streaming response, or the input area when idle). */}
      <Box flexDirection="column" marginTop={1}>
        {!resizing && liveItem ? (
          <Box paddingX={1}>
            <TranscriptRow item={liveItem} />
          </Box>
        ) : null}
        {!resizing && state.running ? (
          <RunStatus startedAt={runStartedAt.current} activity={state.activity} think={think} steeringQueued={steeringCount} />
        ) : null}
        {activeOverlay ?? (
          <InputBox
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            history={history}
            commands={commandItems}
            skills={skillItems}
            resizing={resizing}
            placeholder={pendingSkill ? `value for ${pendingSkill.missing[pendingSkill.index]}` : planNext ? 'planned · your next message will be planned step-by-step' : state.mode === 'agent' ? 'message the agent · /help' : 'chat · /help'}
          />
        )}
        {!resizing ? <StatusLine state={state} /> : null}
      </Box>
    </Box>
  );
}

const BANNER_ID = '__banner__';
type StaticEntry = { id: typeof BANNER_ID } | TranscriptItem;
