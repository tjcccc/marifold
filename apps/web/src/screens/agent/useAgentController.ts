import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { streamChat } from '../../api/chat';
import { getModels, getStatus } from '../../api/misc';
import { getProfile, listProfiles } from '../../api/profiles';
import { answerApproval, cancelRun, listRuns, startRun, steerRun } from '../../api/runs';
import { getSession, listSessions } from '../../api/sessions';
import type {
  ProfileDetail,
  ProfileSummary,
  RunApprovalAction,
  RunRecord,
  SessionSummary,
} from '../../api/types';
import type { Route } from '../../lib/hashRoute';
import { RunFollowers } from '../../state/followers';
import type { ThreadState } from '../../state/thread';
import { activeRun, createThreadState, threadReducer } from '../../state/thread';

const RUN_POLL_INTERVAL_MS = 10_000;

export interface AgentControllerOptions {
  client: ApiClient;
  route: Extract<Route, { view: 'agent' }>;
  navigate: (route: Route) => void;
  /** Called when a request fails auth so the App can open the connection popover. */
  onUnauthorized: () => void;
}

export interface AgentController {
  profiles: ProfileSummary[];
  profileName?: string;
  profileDetail?: ProfileDetail;
  sessions: SessionSummary[];
  sessionId?: string;
  thread: ThreadState;
  steeringRun?: string;
  sending: boolean;
  think: boolean;
  setThink: (on: boolean) => void;
  modelOptions: string[];
  /** "provider/model" or undefined = Auto (profile/config default). */
  modelChoice?: string;
  setModelChoice: (choice?: string) => void;
  send: (text: string) => Promise<void>;
  selectProfile: (name: string) => void;
  selectSession: (id: string) => void;
  newSession: () => void;
  cancel: (runId: string) => Promise<void>;
  answer: (runId: string, requestId: string, action: RunApprovalAction) => Promise<void>;
  toggleRun: (runId: string) => void;
  expandCatchUp: (run: RunRecord) => void;
  dismissCatchUp: () => void;
}

/**
 * The Agent screen's composition layer: owns selection, data loading, the
 * thread reducer, followers, and send routing. Components stay presentational.
 */
export function useAgentController(options: AgentControllerOptions): AgentController {
  const { client, route, navigate, onUnauthorized } = options;

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileDetail, setProfileDetail] = useState<ProfileDetail | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(route.session);
  const [think, setThink] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelChoice, setModelChoice] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const [thread, dispatch] = useReducer(threadReducer, undefined, () => createThreadState(route.session));
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const profileName = route.profile;

  const followers = useMemo(() => new RunFollowers(client, dispatch), [client]);
  useEffect(() => () => followers.stopAll(), [followers]);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') {
        onUnauthorized();
        return;
      }
      dispatch({
        type: 'notice',
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    },
    [onUnauthorized],
  );

  /** Attach running runs of this session; banner recently finished ones. */
  const catchUpRuns = useCallback(
    async (forSession: string) => {
      const runs = await listRuns(client);
      const mine = runs.filter(run => run.sessionId === forSession);
      const finished: RunRecord[] = [];
      for (const run of mine) {
        if (run.status === 'running') followers.attach(run.id);
        else if (!threadRef.current.items.some(item => item.kind === 'run' && item.run.runId === run.id)) {
          finished.push(run);
        }
      }
      if (finished.length > 0) dispatch({ type: 'catch_up', runs: finished });
    },
    [client, followers],
  );

  const loadSession = useCallback(
    async (id: string | undefined) => {
      followers.stopAll();
      dispatch({ type: 'reset', sessionId: id });
      if (!id) return;
      try {
        const detail = await getSession(client, id);
        dispatch({
          type: 'session_loaded',
          turns: detail.turns.map(turn => ({ role: turn.role, content: turn.content })),
        });
      } catch (error) {
        // A freshly minted id has no server session yet — that's expected.
        if (!(error instanceof MarifoldApiError && error.status === 404)) {
          handleError(error);
          return;
        }
      }
      try {
        await catchUpRuns(id);
      } catch (error) {
        handleError(error);
      }
    },
    [client, followers, catchUpRuns, handleError],
  );

  // Bootstrap: profiles, default profile, model options.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profileList, status, models] = await Promise.all([
          listProfiles(client),
          getStatus(client),
          getModels(client),
        ]);
        if (cancelled) return;
        setProfiles(profileList);
        setModelOptions(models.options);
        if (!route.profile) {
          navigate({ view: 'agent', profile: status.default.profile });
        }
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Bootstraps once per client; route.profile is read but must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Profile selection → detail + sessions + think default.
  useEffect(() => {
    if (!profileName) return;
    let cancelled = false;
    (async () => {
      try {
        const [detail, sessionList] = await Promise.all([
          getProfile(client, profileName),
          listSessions(client, { profile: profileName, limit: 50 }),
        ]);
        if (cancelled) return;
        setProfileDetail(detail);
        setSessions(sessionList);
        setThink(detail.settings.think ?? false);
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, profileName, handleError]);

  // External navigation (back/forward, deep link) → adopt the route's session.
  useEffect(() => {
    if (route.session !== sessionId) {
      setSessionId(route.session);
      void loadSession(route.session);
    }
    // Selection changes made by this controller update both together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.session]);

  // Initial session load (deep link straight into a session).
  useEffect(() => {
    if (sessionId) void loadSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for runs started elsewhere (Telegram/TUI) while the tab is visible.
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      catchUpRuns(sessionId).catch(() => undefined);
    }, RUN_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionId, catchUpRuns]);

  const refreshSessions = useCallback(async () => {
    if (!profileName) return;
    try {
      setSessions(await listSessions(client, { profile: profileName, limit: 50 }));
    } catch {
      // List refresh is cosmetic; ignore failures.
    }
  }, [client, profileName]);

  const selectProfile = useCallback(
    (name: string) => {
      followers.stopAll();
      setSessionId(undefined);
      dispatch({ type: 'reset' });
      navigate({ view: 'agent', profile: name });
    },
    [followers, navigate],
  );

  const selectSession = useCallback(
    (id: string) => {
      if (!profileName || id === sessionId) return;
      setSessionId(id);
      navigate({ view: 'agent', profile: profileName, session: id });
      void loadSession(id);
    },
    [profileName, sessionId, navigate, loadSession],
  );

  const newSession = useCallback(() => {
    if (!profileName) return;
    const id = crypto.randomUUID();
    followers.stopAll();
    setSessionId(id);
    dispatch({ type: 'reset', sessionId: id });
    navigate({ view: 'agent', profile: profileName, session: id });
  }, [profileName, followers, navigate]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !profileName) return;

      const running = activeRun(threadRef.current);
      if (running) {
        try {
          await steerRun(client, running.runId, trimmed);
        } catch (error) {
          handleError(error);
        }
        return;
      }

      let sid = sessionId;
      if (!sid) {
        sid = crypto.randomUUID();
        setSessionId(sid);
        navigate({ view: 'agent', profile: profileName, session: sid });
      }

      dispatch({ type: 'user_message', text: trimmed });
      const [provider, model] = splitModelChoice(modelChoice);
      const mode = profileDetail?.settings.mode ?? 'agent';

      if (mode === 'chat') {
        setSending(true);
        dispatch({ type: 'chat_started' });
        try {
          for await (const event of streamChat(client, {
            prompt: trimmed,
            profile: profileName,
            sessionId: sid,
            think,
            provider,
            model,
          })) {
            if (event.type === 'chunk') dispatch({ type: 'chat_chunk', text: event.text });
            else if (event.type === 'error') dispatch({ type: 'chat_error', message: event.message });
            else dispatch({ type: 'chat_done' });
          }
        } catch (error) {
          dispatch({ type: 'chat_done' });
          handleError(error);
        } finally {
          setSending(false);
          void refreshSessions();
        }
        return;
      }

      try {
        setSending(true);
        const run = await startRun(client, {
          objective: trimmed,
          profile: profileName,
          sessionId: sid,
          think,
          provider,
          model,
        });
        dispatch({ type: 'run_created', run });
        followers.attach(run.id);
      } catch (error) {
        handleError(error);
      } finally {
        setSending(false);
      }
    },
    [client, profileName, sessionId, modelChoice, think, profileDetail, followers, navigate, handleError, refreshSessions],
  );

  const cancel = useCallback(
    async (runId: string) => {
      try {
        await cancelRun(client, runId);
      } catch (error) {
        handleError(error);
      }
    },
    [client, handleError],
  );

  const answer = useCallback(
    async (runId: string, requestId: string, action: RunApprovalAction) => {
      dispatch({ type: 'approval_submitting', runId });
      try {
        await answerApproval(client, runId, requestId, action);
        // The approval_decision event on the stream clears the sheet.
      } catch (error) {
        const gone = error instanceof MarifoldApiError && error.code === 'APPROVAL_NOT_FOUND';
        dispatch({
          type: 'approval_failed',
          runId,
          gone,
          message: gone
            ? 'That approval already resolved (answered elsewhere or timed out).'
            : error instanceof Error
              ? error.message
              : String(error),
        });
      }
    },
    [client],
  );

  const toggleRun = useCallback((runId: string) => dispatch({ type: 'toggle_run_details', runId }), []);

  const expandCatchUp = useCallback(
    (run: RunRecord) => {
      dispatch({ type: 'run_created', run: { ...run, status: 'running' } });
      // Replay the finished stream from the start; it closes after done.
      followers.attach(run.id, 0);
      dispatch({ type: 'dismiss_catch_up' });
    },
    [followers],
  );

  const dismissCatchUp = useCallback(() => dispatch({ type: 'dismiss_catch_up' }), []);

  return {
    profiles,
    profileName,
    profileDetail,
    sessions,
    sessionId,
    thread,
    steeringRun: activeRun(thread)?.runId,
    sending,
    think,
    setThink,
    modelOptions,
    modelChoice,
    setModelChoice,
    send,
    selectProfile,
    selectSession,
    newSession,
    cancel,
    answer,
    toggleRun,
    expandCatchUp,
    dismissCatchUp,
  };
}

function splitModelChoice(choice?: string): [string | undefined, string | undefined] {
  if (!choice) return [undefined, undefined];
  const slash = choice.indexOf('/');
  if (slash === -1) return [undefined, choice];
  return [choice.slice(0, slash), choice.slice(slash + 1)];
}
