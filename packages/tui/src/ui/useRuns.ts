import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { randomUUID } from 'crypto';
import type { AgentUsage, ApprovalDecision, ApprovalRequest, ImageInput, UserInputHandler } from '@marifold/core';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText, runSummary } from './appHelpers.js';

interface RunOptions {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  thinkRef: MutableRefObject<boolean>;
  planNextRef: MutableRefObject<boolean>;
  setPlanNext: (planNext: boolean) => void;
  notify: (text: string, tone?: NoticeTone) => void;
  approvalHandler: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  userInputHandler: UserInputHandler;
  cancelPrompts: () => void;
}

/**
 * Agent and chat runs bound to the transcript: starting, steering, retrying,
 * and cancelling them. Owns the run plumbing refs, which do not drive
 * rendering directly.
 */
export function useRuns({
  runtime,
  dispatch,
  stateRef,
  thinkRef,
  planNextRef,
  setPlanNext,
  notify,
  approvalHandler,
  userInputHandler,
  cancelPrompts,
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
    // One conversation session shared with chat mode, so the agent remembers
    // earlier turns. Skills pass their body via `instructions` (authoritative,
    // not persisted) rather than isolating, so context-aware skills still see
    // the conversation.
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) { dispatch({ type: 'set_session', sessionId }); }
    dispatch({ type: 'set_running', running: true });
    // Shown until the first run event: a large upload to a remote workspace
    // can take a while before the host starts the task.
    dispatch({ type: 'set_activity', activity: 'sending' });
    const startedAt = Date.now();
    let usage: AgentUsage | undefined;
    let doneStatus: string | undefined;
    try {
      await runtime.acquireSession?.(sessionId);
      const runner = runtime.createAgentRunner(current.profile);
      for await (const event of runner.run({
        objective,
        think: thinkRef.current,
        profile: current.profile,
        provider: current.provider,
        model: current.model,
        sessionId,
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
      if (usage?.inputTokens != null) { dispatch({ type: 'set_context_usage', tokens: usage.inputTokens }); }
      if (controller.signal.aborted) {
        notify('Cancelled.', 'warn');
      } else {
        const status = doneStatus ?? 'ended';
        notify(`Task ${status}. ${runSummary(Date.now() - startedAt, usage)}`, status === 'completed' ? 'info' : 'warn');
      }
    }
  }, [runtime, approvalHandler, userInputHandler, notify]);

  const runChat = useCallback(async (
    prompt: string,
    extraContext: string[] = [],
    options: {
      instructions?: string[];
      originalImages?: boolean;
      userTurn?: string;
      isolated?: boolean;
    } = {},
  ) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const current = stateRef.current;
    const sessionId = current.sessionId ?? randomUUID();
    if (!current.sessionId) { dispatch({ type: 'set_session', sessionId }); }
    const userContext = [...extraContext, ...pendingContextRef.current];
    pendingContextRef.current = [];
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    dispatch({ type: 'set_running', running: true });
    dispatch({ type: 'set_activity', activity: 'thinking' });
    const startedAt = Date.now();
    let usage: AgentUsage | undefined;
    try {
      await runtime.acquireSession?.(sessionId);
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
          ...(options.userTurn ? { userTurn: options.userTurn } : {}),
          ...(options.isolated ? { isolated: true } : {}),
          ...(options.originalImages ? { originalImages: true } : {}),
          images: images.length > 0 ? images : undefined,
          signal: controller.signal,
        },
        summary => { usage = summary.usage; },
        text => { dispatch({ type: 'reasoning_delta', text }); },
      )) {
        if (controller.signal.aborted) { break; }
        dispatch({ type: 'assistant_delta', text: chunk });
      }
    } catch (error) {
      if (!controller.signal.aborted) { notify(errorText(error), 'error'); }
    } finally {
      dispatch({ type: 'end_assistant' });
      dispatch({ type: 'set_running', running: false });
      abortRef.current = null;
      if (usage?.inputTokens != null) { dispatch({ type: 'set_context_usage', tokens: usage.inputTokens }); }
      if (controller.signal.aborted) { notify('Cancelled.', 'warn'); }
      else { notify(runSummary(Date.now() - startedAt, usage), 'info'); }
    }
  }, [runtime, notify]);

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
    if (stateRef.current.mode === 'chat') { void runChat(text, [], options); }
    else { void runAgent(text, options); }
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
    cancelPrompts();
    if (stateRef.current.running) { notify('Cancelling…', 'warn'); }
  }, [notify, cancelPrompts]);

  return {
    runAgent,
    runChat,
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
