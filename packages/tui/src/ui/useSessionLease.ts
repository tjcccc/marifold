import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { renewSessionLease } from '@marifold/client';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { sessionBusyText, sessionLostText } from './appHelpers.js';

interface SessionLeaseOptions {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  runGenerationRef: MutableRefObject<number>;
  abortRef: MutableRefObject<AbortController | null>;
  notify: (text: string, tone?: NoticeTone) => void;
}

/**
 * Hold the open session's lease. When another page, terminal, or app takes the
 * session over, it stays open here read-only: `lostSessionRef` names it until
 * `takeOver` (the /takeover command) reclaims it or another session replaces it.
 */
export function useSessionLease({ runtime, dispatch, stateRef, runGenerationRef, abortRef, notify }: SessionLeaseOptions) {
  const sessionId = stateRef.current.sessionId;
  const [lostSessionId, setLostSessionId] = useState<string | undefined>(undefined);
  const lostSessionRef = useRef<string | undefined>(undefined);
  lostSessionRef.current = lostSessionId;

  useEffect(() => {
    const id = sessionId;
    if (!id || !runtime.acquireSession || lostSessionId === id) { return; }
    const lease = renewSessionLease({
      // Called on the runtime: the local MarifoldRuntime method needs its `this`.
      acquire: () => runtime.acquireSession?.(id),
      immediate: true,
      onLost: () => {
        if (stateRef.current.sessionId !== id) { return; }
        // Another device took the session over. A service-hosted task keeps
        // running there, so only stop following it; a task running inside
        // this terminal process cannot move and is cancelled.
        runGenerationRef.current += 1;
        if (!runtime.remote) { abortRef.current?.abort(); }
        abortRef.current = null;
        dispatch({ type: 'set_running', running: false });
        setLostSessionId(id);
        notify(sessionLostText(id), 'warn');
      },
    });
    return () => {
      lease.stop();
      void Promise.resolve(runtime.releaseSession?.(id)).catch(() => undefined);
    };
  }, [runtime, sessionId, lostSessionId, notify]);

  const takeOver = useCallback(async () => {
    const id = stateRef.current.sessionId;
    if (!id || lostSessionRef.current !== id) { notify('This session is already open here.', 'info'); return; }
    try {
      await runtime.takeOverSession?.(id);
      setLostSessionId(undefined);
      notify(`Took over session ${id.slice(0, 8)} — your next message continues it.`, 'info');
    } catch (error) { notify(sessionBusyText(error, id), 'error'); }
  }, [runtime, notify]);

  return { lostSessionRef, takeOver };
}
