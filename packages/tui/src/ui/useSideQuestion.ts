import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { AppState, TranscriptItem } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText } from './appHelpers.js';

/** What the `/btw` panel shows: the question, then its answer or error. */
export interface SideQuestionView {
  question: string;
  answer?: string;
  error?: string;
}

const CONTEXT_LIMIT = 24_000;
const SIDE_INSTRUCTION = 'The user is asking a quick side question about the conversation below, '
  + 'possibly while a task is still running. Answer briefly and directly from that conversation. '
  + 'You cannot use tools or take actions here; if the answer is not in the conversation, say so.';

/** The visible conversation, newest last, capped to the most recent part. */
export function conversationContext(transcript: TranscriptItem[]): string {
  const lines = transcript.flatMap(item => {
    if (item.kind === 'user') { return [`User: ${item.text}`]; }
    if (item.kind === 'assistant') { return [`Assistant: ${item.text}`]; }
    if (item.kind === 'tool' && item.phase === 'request') { return [`Tool ${item.tool}: ${item.summary}`]; }
    if (item.kind === 'tool' && item.isError) { return [`Tool ${item.tool} failed: ${item.summary}`]; }
    if (item.kind === 'plan') { return [`Plan: ${item.steps.map(step => `${step.text} (${step.status})`).join('; ')}`]; }
    return [];
  });
  const text = lines.join('\n\n');
  return `Conversation so far:\n${text.length > CONTEXT_LIMIT ? `…${text.slice(-CONTEXT_LIMIT)}` : text || '(nothing yet)'}`;
}

/**
 * `/btw <question>`: a one-off, tool-less model call that sees the visible
 * conversation (including a running task's progress) and is never saved to the
 * session, so it neither steers nor interrupts the running task.
 */
export function useSideQuestion({ runtime, stateRef }: { runtime: TuiRuntime; stateRef: MutableRefObject<AppState> }) {
  const [view, setView] = useState<SideQuestionView>();
  const generation = useRef(0);

  const ask = useCallback((question: string) => {
    const id = ++generation.current;
    setView({ question });
    const state = stateRef.current;
    // No sessionId: the answer is shown, never persisted. The conversation
    // travels in the user message (the service's /v1/ask has no userContext).
    void Promise.resolve(runtime.ask({
      prompt: `${conversationContext(state.transcript)}\n\nSide question: ${question}`,
      profile: state.profile,
      provider: state.provider,
      model: state.model,
      memories: false,
      instructions: [SIDE_INSTRUCTION],
    }))
      .then(response => {
        if (id !== generation.current) { return; }
        setView(response.ok ? { question, answer: response.text } : { question, error: response.error?.message ?? 'No answer.' });
      })
      .catch(error => { if (id === generation.current) { setView({ question, error: errorText(error) }); } });
  }, [runtime, stateRef]);

  const close = useCallback(() => {
    generation.current += 1;
    setView(undefined);
  }, []);

  return { view, ask, close };
}
