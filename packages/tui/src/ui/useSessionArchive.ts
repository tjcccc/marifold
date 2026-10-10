import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText } from './appHelpers.js';

export const ARCHIVED_SESSION_TEXT = 'This session has been archived. Use /unarchive to continue it, or /new to start another.';

/** `/archive` and `/unarchive` for the open session. An archived session can
 * be read here, but a message only shows ARCHIVED_SESSION_TEXT; the runtime
 * refuses new turns in it as well. */
export function useSessionArchive({ runtime, stateRef, notify }: {
  runtime: TuiRuntime;
  stateRef: MutableRefObject<AppState>;
  notify: (text: string, tone?: NoticeTone) => void;
}) {
  /** The open session's id while it is archived. */
  const archivedSessionRef = useRef<string | undefined>(undefined);

  const markArchived = useCallback((sessionId: string, archived: boolean | undefined) => {
    archivedSessionRef.current = archived ? sessionId : undefined;
    if (archived) { notify(ARCHIVED_SESSION_TEXT, 'warn'); }
  }, [notify]);

  const isArchived = useCallback(() => {
    const id = stateRef.current.sessionId;
    return id !== undefined && archivedSessionRef.current === id;
  }, [stateRef]);

  const setArchived = useCallback(async (archived: boolean) => {
    const id = stateRef.current.sessionId;
    if (!id) { notify('No session is open yet.', 'warn'); return; }
    if (archived && stateRef.current.running) { notify('Stop the running task before archiving this session.', 'warn'); return; }
    try {
      await runtime.updateSessionDisplay(id, { archived });
      archivedSessionRef.current = archived ? id : undefined;
      notify(archived ? 'Archived this session. It is hidden from /resume (see /resume --archived); /unarchive continues it.' : 'Unarchived — your next message continues this session.', 'info');
    } catch (error) { notify(errorText(error), 'error'); }
  }, [runtime, stateRef, notify]);

  return { isArchived, markArchived, setArchived };
}
