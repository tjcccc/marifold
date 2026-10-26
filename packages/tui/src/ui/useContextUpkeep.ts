import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import type { AppAction, AppState } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';

/** Budget bookkeeping after each task: an `auto` budget learns the model's
 * window in the background, so the gauge's budget is refreshed unless
 * `/context-window set` chose a session budget. */
export function useContextUpkeep({ runtime, stateRef, running, dispatch }: {
  runtime: TuiRuntime;
  stateRef: MutableRefObject<AppState>;
  running: boolean;
  dispatch: Dispatch<AppAction>;
}): void {
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const s = stateRef.current;
    const finished = wasRunningRef.current && !running;
    wasRunningRef.current = running;
    if (!finished) { return; }
    if (s.sessionContextBudget) { return; }
    // A workspace TUI reads the host's settings from a snapshot: renew it first.
    void Promise.resolve(runtime.refresh?.()).then(() => {
      const next = runtime.resolveSettings({ profile: s.profile, provider: s.provider, model: s.model }).maxContextTokens;
      if (!stateRef.current.sessionContextBudget && next !== stateRef.current.maxContextTokens) { dispatch({ type: 'set_context_budget', maxContextTokens: next }); }
    }).catch(() => { /* keep the shown budget */ });
  }, [runtime, running]);
}
