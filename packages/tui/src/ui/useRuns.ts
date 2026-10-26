import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { randomUUID } from 'crypto';
import { trustedFolderEntry } from '@marifold/core';
import type { AgentUsage, ApprovalDecision, ApprovalRequest, ImageInput, UserInputHandler } from '@marifold/core';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText, runSummary } from './appHelpers.js';

interface RunOptions {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  deepRef: MutableRefObject<boolean>;
  planNextRef: MutableRefObject<boolean>;
  setPlanNext: (planNext: boolean) => void;
  notify: (text: string, tone?: NoticeTone) => void;
  approvalHandler: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  userInputHandler: UserInputHandler;
  cancelPrompts: () => void;
  /** Forget the previous run's "for this run" folder approvals. */
  beginRunApprovals: () => void;
  /** `/add-dir` folders for this session (`~/…` or absolute). */
  sessionDirsRef: MutableRefObject<string[]>;
}

/**
 * Agent runs bound to the transcript: starting, steering, retrying,
 * and cancelling them. Owns the run plumbing refs, which do not drive
 * rendering directly.
 */
export function useRuns({
  runtime,
  dispatch,
  stateRef,
  deepRef,
  planNextRef,
  setPlanNext,
  notify,
  approvalHandler,
  userInputHandler,
  cancelPrompts,
  beginRunApprovals,
  sessionDirsRef,
}: RunOptions) {
  const abortRef = useRef<AbortController | null>(null);
  const steeringRef = useRef<string[]>([]);
  const [steeringCount, setSteeringCount] = useState(0);
  const pendingContextRef = useRef<string[]>([]);
  const pendingImagesRef = useRef<ImageInput[]>([]);
  // Increments per agent run; a detached run's events no longer reach the view.
  const runGenerationRef = useRef(0);
  // Last plain-text prompt, for `/retry`.
  const lastPromptRef = useRef<string | null>(null);

  // The folder the TUI was launched in, home-relative when inside home.
  const launchFolder = useRef(trustedFolderEntry(process.cwd())).current;

  // --- Runs ----------------------------------------------------------------
  const runAgent = useCallback(async (objective: string, options: { instructions?: string[]; userTurn?: string; lean?: boolean; forcePlan?: boolean; originalImages?: boolean } = {}) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++runGenerationRef.current;
    steeringRef.current = [];
    setSteeringCount(0);
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    const current = stateRef.current;
    // One conversation session, so the agent remembers earlier turns. Skills pass their body via `instructions` (authoritative,
    // not persisted) rather than isolating, so context-aware skills still see
    // the conversation.
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) { dispatch({ type: 'set_session', sessionId }); }
    dispatch({ type: 'set_running', running: true });
    // Shown until the first run event: a large upload to a remote workspace
    // can take a while before the host starts the task.
    dispatch({ type: 'set_activity', activity: 'sending' });
    const startedAt = Date.now();
    beginRunApprovals();
    let usage: AgentUsage | undefined;
    let doneStatus: string | undefined;
    let compacted = false;
    try {
      await runtime.acquireSession?.(sessionId);
      const runner = runtime.createAgentRunner(current.profile);
      for await (const event of runner.run({
        objective,
        deep: deepRef.current,
        profile: current.profile,
        provider: current.provider,
        model: current.model,
        sessionId,
        // A `/context-window set` budget (0 = off) overrides the profile's for this session.
        ...(current.sessionContextBudget ? { maxContextTokens: current.maxContextTokens ?? 0 } : {}),
        ...(sessionDirsRef.current.length > 0 ? { trustedFolders: [...sessionDirsRef.current] } : {}),
        // A workspace host resolves `~/…` on the execution device; a local run
        // already works in this directory.
        ...(runtime.remote && launchFolder.startsWith('~/') ? { cwd: launchFolder } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.userTurn ? { userTurn: options.userTurn } : {}),
        ...(options.lean ? { lean: true } : {}),
        ...(options.forcePlan ? { forcePlan: true } : {}),
        ...(options.originalImages ? { originalImages: true } : {}),
        ...(images.length > 0 ? { images } : {}),
        signal: controller.signal,
        approvalHandler,
        userInputHandler,
        steering: () => {
          const queued = steeringRef.current;
          steeringRef.current = [];
          setSteeringCount(0);
          return queued;
        },
      })) {
        // The session moved to another device; leave the task to it.
        if (runGenerationRef.current !== generation) { break; }
        if (event.type === 'compaction' && event.status === 'completed') { compacted = true; }
        if (event.type === 'done') {
          usage = event.usage;
          doneStatus = event.status;
        }
        dispatch({ type: 'agent_event', event });
      }
    } catch (error) {
      if (!controller.signal.aborted && runGenerationRef.current === generation) { notify(errorText(error), 'error'); }
    } finally {
      if (runGenerationRef.current !== generation) { return; }
      dispatch({ type: 'set_running', running: false });
      abortRef.current = null;
      // The fullest single model call, not the run's summed input; a compaction
      // made that stale, so the gauge restarts until the next call measures it.
      const context = compacted ? 0 : usage?.contextTokens ?? usage?.inputTokens;
      if (context != null) { dispatch({ type: 'set_context_usage', tokens: context }); }
      if (controller.signal.aborted) {
        notify('Cancelled.', 'warn');
      } else {
        const status = doneStatus ?? 'ended';
        notify(`Task ${status}. ${runSummary(Date.now() - startedAt, usage)}`, status === 'completed' ? 'info' : 'warn');
      }
    }
  }, [runtime, approvalHandler, userInputHandler, notify, beginRunApprovals]);

  const startTextRun = useCallback((text: string, options: { originalImages?: boolean } = {}) => {
    // Remember the last plain-text prompt so `/retry` can re-run it. Captured
    // here (the sole text-run entry) rather than read from the transcript, which
    // also records `/command` and `$skill` echoes as user items.
    lastPromptRef.current = text;
    dispatch({ type: 'add_user', text });
    // `/steps` armed: run this turn as a planned agent turn (planning is an agent
    // concept), then auto-disarm.
    if (planNextRef.current) {
      setPlanNext(false);
      void runAgent(text, { ...options, forcePlan: true });
      return;
    }
    void runAgent(text, options);
  }, [runAgent]);

  // Re-run the last plain-text message through the current profile/model —
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
    cancelPrompts();
    // The status line shows "Cancelling…" until the run ends; then the
    // transcript records "Cancelled." once.
    if (stateRef.current.running) { dispatch({ type: 'set_cancelling' }); }
  }, [dispatch, cancelPrompts]);

  return {
    runAgent,
    startTextRun,
    retryLast,
    stop,
    steeringCount,
    setSteeringCount,
    steeringRef,
    abortRef,
    runGenerationRef,
    pendingContextRef,
    pendingImagesRef,
  };
}
