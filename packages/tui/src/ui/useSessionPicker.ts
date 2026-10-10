import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { sessionPromptHistory } from '../core/promptHistory.js';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText, sessionBusyText } from './appHelpers.js';
import type { InputHistoryEntry } from './InputBox.js';
import type { SelectItem } from './SelectList.js';
import { sessionItem } from './sessionItems.js';

export interface SessionsOverlay { type: 'sessions'; items: SelectItem[]; inUse: string[]; message?: string; title?: string }

/** The `/resume` session picker (recent or archived sessions) and opening the
 * chosen session. `--sessions` launches on it, so cancelling that launch
 * picker has nothing to go back to (see `launchPickerRef`). */
export function useSessionPicker({ runtime, dispatch, stateRef, setOverlay, setHistory, notify, markArchived, pickOnLaunch }: {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  setOverlay: (overlay: SessionsOverlay | null) => void;
  setHistory: (history: InputHistoryEntry[]) => void;
  notify: (text: string, tone?: NoticeTone) => void;
  markArchived: (sessionId: string, archived: boolean | undefined) => void;
  pickOnLaunch: boolean;
}) {
  const launchPickerRef = useRef(pickOnLaunch);

  const showSessions = useCallback(async (archived = false) => {
    if (stateRef.current.running) {
      notify('Stop the running task before switching sessions.', 'warn');
      return;
    }
    const currentSessionId = stateRef.current.sessionId;
    const sessions = await runtime.listSessions(20, stateRef.current.profile, { order: 'recent', archived });
    setOverlay({
      type: 'sessions',
      ...(archived ? { title: 'Archived sessions' } : {}),
      items: sessions.map(session => sessionItem(currentSessionId, session)),
      inUse: sessions.filter(session => session.inUse).map(session => session.id),
    });
  }, [runtime, stateRef, setOverlay, notify]);

  // Open a session from the /resume picker; `takeover` moves it here from the
  // page or terminal that holds it.
  const openSession = useCallback(async (value: string, takeover: boolean) => {
    try {
      setOverlay(null);
      launchPickerRef.current = false;
      if (takeover) { await runtime.takeOverSession?.(value); }
      else { await runtime.acquireSession?.(value); }
      const detail = await runtime.getSession(value);
      if (!detail) {
        await runtime.releaseSession?.(value);
        notify(`Session not found: ${value}`, 'error');
        return;
      }
      dispatch({ type: 'new_session', sessionId: detail.id });
      setHistory(sessionPromptHistory(detail));
      for (const turn of detail.turns) {
        dispatch({ type: 'add_item', item: { kind: turn.role === 'user' ? 'user' : 'assistant', text: turn.content } });
      }
      notify(`${takeover ? 'Took over' : 'Resumed'} session ${detail.id.slice(0, 8)} — your next message continues it.`, 'info');
      markArchived(detail.id, detail.archived);
    } catch (error) { notify(sessionBusyText(error, value), 'error'); }
  }, [runtime, dispatch, setOverlay, setHistory, notify, markArchived]);

  useEffect(() => {
    if (pickOnLaunch) { void showSessions().catch(error => notify(errorText(error), 'error')); }
  }, []);

  return { showSessions, openSession, launchPickerRef };
}
