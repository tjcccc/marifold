import type { SudoResponse } from '../../api/types';
import { SeenRuns } from '../../lib/seenRuns';
import { useWorkspaceChanges } from '../../state/workspaceChanges';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { streamChat } from '../../api/chat';
import { getModels, getSkills, resolveSkillInvocation } from '../../api/misc';
import type { ResolvedSkillInvocation, SkillHint } from '../../api/misc';
import {
  getProfile,
  listProfiles,
  setProfilePinned as setProfilePinnedRequest,
} from '../../api/profiles';
import { answerApproval, answerUserInput, cancelRun, listRuns, startRun } from '../../api/runs';
import { usePromptQueue, type PromptQueue } from './usePromptQueue';
import {
  acquireSessionLease,
  deleteSessionWhenIdle,
  getSession,
  isSessionBusy,
  listSessions,
  updateSession,
  waitForSessionRunsToSettle,
} from '../../api/sessions';
import type {
  ProfileDetail,
  ProfileSummary,
  ProjectDetail,
  RunApprovalAction,
  RunRecord,
  SessionSummary,
  UserInputSubmission,
} from '../../api/types';
import type { ChatRoute, Route } from '../../lib/route';
import { afterLeadingMentions, answeringProfile, previewProjectRoute } from '../../lib/projectRouting';
import { inviteProjectMember, listProjectSessions, moveSessionToProject } from '../../api/projects';
import type { PreparedAttachment } from '../../lib/attachments';
import { MAX_TOTAL_BYTES, prepareFiles } from '../../lib/attachments';
import { parseCommand } from '../../lib/commandSyntax';
import { splitModelChoice } from '../../lib/modelChoice';
import { createClientId } from '../../lib/id';
import { withPendingSession } from '../../lib/sessionSummaries';
import { RunFollowers } from '../../state/followers';
import type { ThreadState } from '../../state/thread';
import { activeRun, createThreadState, threadReducer } from '../../state/thread';
import { preparedAttachmentsFromUser, threadTurns } from './sessionAttachments';
import { runAgentCommand } from './agentCommands';
import { useGlobalDeep } from './useGlobalDeep';
import { useSessionLease } from './useSessionLease';
import { useExecutionDevices } from './useExecutionDevices';
import { useProject } from './useProject';
import { messagePayload } from './messagePayload';


export interface AgentControllerOptions {
  client: ApiClient;
  route: ChatRoute;
  navigate: (route: Route) => void;
  /** Called when a request fails auth so the App can open the connection popover. */
  onUnauthorized: () => void;
}

export interface AgentController {
  profiles: ProfileSummary[];
  /** The profile a message goes to: the selected one, or in a project the one
   * that answers a message addressing no one (the floor, else the Lead). */
  profileName?: string;
  /** The selected project in the Projects view, once loaded. */
  project?: ProjectDetail;
  projectMissing: boolean;
  /** In a project session, who answers a message addressing no one. */
  floor?: string;
  selectProject: (id: string) => void;
  refreshProject: () => Promise<void>;
  inviteToProject: (profile: string) => Promise<void>;
  /** Move a session into a project; the open conversation follows it there. */
  moveSession: (id: string, projectId: string) => Promise<boolean>;
  profileDetail?: ProfileDetail;
  /** Skills for the composer's $-autocomplete (active-profile-scoped). */
  skills: SkillHint[];
  devices: SkillHint[];
  sessions: SessionSummary[];
  sessionSearch: string;
  setSessionSearch: (value: string) => void;
  showArchivedSessions: boolean;
  setShowArchivedSessions: (value: boolean) => void;
  runningSessionIds: ReadonlySet<string>;
  sessionId?: string;
  thread: ThreadState;
  sessionLoading: boolean;
  sessionBlocked: boolean;
  /** Move a session open on another of the owner's devices to this page. */
  takeOverSession: () => Promise<void>;
  /** Request bytes of a message still uploading, before its run exists. */
  sendingBytes?: number;
  profilesLoading: boolean;
  sessionsLoading: boolean;
  steeringRun?: string;
  /** Prompts typed while a reply is in progress (`usePromptQueue`). */
  promptQueue: PromptQueue;
  /** True while the selected conversation has a live chat or agent response. */
  responding: boolean;
  sending: boolean;
  deep: boolean;
  setDeep: (on: boolean) => void;
  modelOptions: string[];
  /** "provider/model" or undefined = Auto (profile/config default). */
  modelChoice?: string;
  setModelChoice: (choice?: string) => void;
  /** Prepared attachments for the next message (cleared on send). */
  attachments: PreparedAttachment[];
  addFiles: (files: Iterable<File>) => Promise<void>;
  removeAttachment: (index: number) => void;
  send: (text: string) => Promise<void>;
  resendEdited: (userItemId: string, text: string) => Promise<boolean>;
  refreshProfiles: () => Promise<void>;
  setProfilePinned: (name: string, pinned: boolean) => Promise<boolean>;
  showProfiles: () => void;
  selectProfile: (name: string) => void;
  selectSession: (id: string) => void;
  newSession: () => void;
  renameSession: (id: string, title: string) => Promise<boolean>;
  setSessionPinned: (id: string, pinned: boolean) => Promise<boolean>;
  setSessionArchived: (id: string, archived: boolean) => Promise<boolean>;
  deleteSession: (id: string) => Promise<boolean>;
  cancel: (runId: string) => Promise<void>;
  stop: () => Promise<boolean>;
  answer: (runId: string, requestId: string, action: RunApprovalAction, sudoResponse?: SudoResponse) => Promise<void>;
  answerInput: (runId: string, requestId: string, submission: UserInputSubmission) => Promise<void>;
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

  const [profilesLoading, setProfilesLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(Boolean(route.view === 'agent' ? route.profile : route.project));
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileDetail, setProfileDetail] = useState<ProfileDetail | undefined>();
  const [skills, setSkills] = useState<SkillHint[]>([]);
  const devices = useExecutionDevices(client);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [persistedSessionIds, setPersistedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionSearch, setSessionSearch] = useState('');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(route.session);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [sendingBytes, setSendingBytes] = useState<number>();
  const [sessionLoading, setSessionLoading] = useState(Boolean(route.session));
  const sessionLoadRef = useRef(0);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelChoice, setModelChoice] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [chatResponding, setChatResponding] = useState(false);

  const [thread, dispatch] = useReducer(threadReducer, undefined, () => createThreadState(route.session));
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const resetThread = useCallback((id?: string) => {
    sessionLoadRef.current += 1;
    setSessionLoading(false);
    dispatch({ type: 'reset', sessionId: id });
    return sessionLoadRef.current;
  }, []);
  useEffect(() => () => { sessionLoadRef.current += 1; }, []);

  const routeProfile = route.view === 'agent' ? route.profile : undefined;
  const projectId = route.view === 'projects' ? route.project : undefined;
  const projectState = useProject(client, projectId);
  const { project } = projectState;
  const [floor, setFloor] = useState<string>();
  const profileName = route.view === 'projects' ? (project ? answeringProfile(project, floor) : undefined) : routeProfile;
  // What the session list, drafts and routes belong to: a profile or a project.
  const scopeKey = projectId ? `project:${projectId}` : routeProfile;
  const sessionRoute = useCallback((session?: string): ChatRoute => projectId
    ? { view: 'projects', project: projectId, ...(session ? { session } : {}) }
    : { view: 'agent', ...(routeProfile ? { profile: routeProfile } : {}), ...(session ? { session } : {}) }, [projectId, routeProfile]);
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, PreparedAttachment[]>>({});
  const attachmentDraftKey = `${scopeKey ?? '_'}:${sessionId ?? 'new'}`;
  const attachments = attachmentDrafts[attachmentDraftKey] ?? [];
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const refreshSessionsRef = useRef<() => void>(() => undefined);
  const refreshRunsRef = useRef<() => void>(() => undefined);
  const reloadSessionRef = useRef<() => void>(() => undefined);
  const editedRunIdsRef = useRef(new Set<string>());
  const seenRuns = useMemo(() => new SeenRuns(client.baseUrl), [client]);
  const activeChatRef = useRef<{ sessionId: string; controller: AbortController } | undefined>(undefined);
  const abortActiveChat = useCallback((): boolean => {
    if (!activeChatRef.current) { return false; }
    activeChatRef.current.controller.abort();
    activeChatRef.current = undefined;
    setChatResponding(false);
    return true;
  }, []);
  const followers = useMemo(
    () => new RunFollowers(client, dispatch, runId => {
      refreshSessionsRef.current();
      refreshRunsRef.current();
      if (editedRunIdsRef.current.delete(runId)) {
        // The answers an edit replaced were seen here; the reload must not banner them.
        for (const id of [runId, ...threadRef.current.discardedRunIds]) { seenRuns.add(id); }
        reloadSessionRef.current();
      }
    }, () => refreshSessionsRef.current(), (runId, nextRunId) => {
      // A regenerated message reloads once its last speaker is done.
      if (editedRunIdsRef.current.delete(runId)) { seenRuns.add(runId); editedRunIdsRef.current.add(nextRunId); }
    }),
    [client, seenRuns],
  );
  useEffect(() => () => followers.stopAll(), [followers]);
  useEffect(() => () => { abortActiveChat(); }, [abortActiveChat]);

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
  const [deep, setDeep] = useGlobalDeep(client, handleError);
  const promptQueue = usePromptQueue(client, thread, sending || chatResponding || activeRun(thread) !== undefined, text => sendMessage(text), handleError);

  const rememberPersistedSessionIds = useCallback((ids: Iterable<string>) => {
    setPersistedSessionIds(current => {
      let next: Set<string> | undefined;
      for (const id of ids) {
        if (current.has(id)) { continue; }
        next ??= new Set(current);
        next.add(id);
      }
      return next ?? current;
    });
  }, []);

  const forgetPersistedSessionId = useCallback((id: string) => {
    setPersistedSessionIds(current => {
      if (!current.has(id)) { return current; }
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  /** Attach running runs of this session; restore finished deliverables and
   * banner other recently finished runs. */
  const catchUpRuns = useCallback(
    async (forSession: string, loadId: number) => {
      const [runs, sessionRuns] = await Promise.all([listRuns(client), listRuns(client, forSession)]);
      if (loadId !== sessionLoadRef.current) { return; }
      setRuns(runs);
      const mine = sessionRuns.filter(
        run => run.sessionId === forSession && !seenRuns.has(run.id),
      );
      const finished: RunRecord[] = [];
      for (const run of mine) {
        if (run.status === 'running') {
          // The record names the speaker, which a card made from events would not.
          dispatch({ type: 'run_created', run });
          followers.attach(run.id);
        }
        else if (!threadRef.current.items.some(item => item.kind === 'run' && item.run.runId === run.id)) {
          finished.push(run);
        }
      }
      if (finished.length > 0) { dispatch({ type: 'catch_up', runs: finished }); }
    },
    [client, followers, seenRuns],
  );

  const loadSession = useCallback(
    async (id: string | undefined) => {
      followers.stopAll();
      const loadId = resetThread(id);
      setSessionBlocked(false);
      setFloor(undefined);
      if (!id) { return; }
      setSessionLoading(true);
      try {
        await acquireSessionLease(client, id);
        setSessionBlocked(false);
        const detail = await getSession(client, id);
        if (loadId !== sessionLoadRef.current) { return; }
        rememberPersistedSessionIds([id]);
        setFloor(detail.floor);
        dispatch({ type: 'session_loaded', turns: threadTurns(id, detail.turns) });
      } catch (error) {
        if (loadId !== sessionLoadRef.current) { return; }
        if (isSessionBusy(error)) { setSessionBlocked(true); }
        // A freshly minted id has no server session yet — that's expected.
        if (!(error instanceof MarifoldApiError && error.status === 404)) {
          handleError(error);
          return;
        }
        forgetPersistedSessionId(id);
      } finally {
        if (loadId === sessionLoadRef.current) { setSessionLoading(false); }
      }
      try {
        await catchUpRuns(id, loadId);
      } catch (error) {
        if (loadId === sessionLoadRef.current) { handleError(error); }
      }
    },
    [client, followers, catchUpRuns, forgetPersistedSessionId, handleError, rememberPersistedSessionIds, resetThread],
  );

  useEffect(() => {
    setPersistedSessionIds(new Set());
  }, [client]);

  // Bootstrap the profile list and model options. The root Agent route stays
  // on the profile picker; only an explicit route selects a profile.
  useEffect(() => {
    let cancelled = false;
    setProfilesLoading(true);
    (async () => {
      try {
        const [profileList, models] = await Promise.all([
          listProfiles(client),
          getModels(client),
        ]);
        if (cancelled) { return; }
        setProfiles(profileList);
        setModelOptions(models.options);
      } catch (error) {
        if (!cancelled) { handleError(error); }
      } finally {
        if (!cancelled) { setProfilesLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [client, handleError]);

  // Profile selection → detail and skills.
  useEffect(() => {
    if (!profileName) { return; }
    let cancelled = false;
    (async () => {
      try {
        const [detail, skillList] = await Promise.all([
          getProfile(client, profileName),
          getSkills(client, profileName).catch(() => [] as SkillHint[]),
        ]);
        if (cancelled) { return; }
        setProfileDetail(detail);
        setSkills(skillList);
      } catch (error) {
        // An unknown profile shows the screen's "doesn't exist" state instead.
        if (!cancelled && !(error instanceof MarifoldApiError && error.code === 'PROFILE_INVALID')) { handleError(error); }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, profileName, handleError]);

  // Session search/archive filters are server-backed so results are not
  // limited to whichever 50 rows happened to load first.
  const fetchSessions = useCallback(() => {
    const filters = { limit: 100, archived: showArchivedSessions, search: sessionSearch };
    return projectId ? listProjectSessions(client, projectId, filters) : listSessions(client, { ...filters, profile: routeProfile });
  }, [client, projectId, routeProfile, sessionSearch, showArchivedSessions]);
  useEffect(() => {
    if (!scopeKey) { setSessionsLoading(false); return; }
    let cancelled = false;
    setSessionsLoading(true);
    const timer = window.setTimeout(() => {
      fetchSessions().then(result => {
        if (!cancelled) {
          rememberPersistedSessionIds(result.map(session => session.id));
          setSessions(result);
        }
      }).catch(error => {
        if (!cancelled) { handleError(error); }
      }).finally(() => {
        if (!cancelled) { setSessionsLoading(false); }
      });
    }, sessionSearch ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchSessions, handleError, scopeKey, rememberPersistedSessionIds, sessionSearch]);

  // External navigation (back/forward, deep link) → adopt the route's session.
  useEffect(() => {
    if (route.session !== sessionId) {
      abortActiveChat();
      setSessionId(route.session);
      void loadSession(route.session);
    }
    // Selection changes made by this controller update both together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.session]);

  // Initial session load (deep link straight into a session).
  useEffect(() => {
    if (sessionId) { void loadSession(sessionId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles(client));
    } catch {
      // List refresh is cosmetic; ignore failures.
    }
  }, [client]);

  const setProfilePinned = useCallback(async (name: string, pinned: boolean): Promise<boolean> => {
    try {
      setProfiles(await setProfilePinnedRequest(client, name, pinned));
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [client, handleError]);

  const refreshSessions = useCallback(async (forSession = sessionId) => {
    if (!scopeKey) { return; }
    try {
      const result = await fetchSessions();
      rememberPersistedSessionIds(result.map(session => session.id));
      setSessions(result);
      if (forSession && !result.some(session => session.id === forSession)) {
        try {
          await getSession(client, forSession);
          rememberPersistedSessionIds([forSession]);
        } catch (error) {
          if (error instanceof MarifoldApiError && error.status === 404) {
            forgetPersistedSessionId(forSession);
          }
        }
      }
    } catch {
      // List refresh is cosmetic; ignore failures.
    }
  }, [client, fetchSessions, forgetPersistedSessionId, scopeKey, rememberPersistedSessionIds, sessionId]);
  refreshSessionsRef.current = () => { void refreshSessions(); };
  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await listRuns(client));
    } catch {
      // Run status is advisory UI state; the service remains authoritative.
    }
  }, [client]);
  refreshRunsRef.current = () => { void refreshRuns(); };
  reloadSessionRef.current = () => { if (sessionId) { void loadSession(sessionId); } };

  useWorkspaceChanges(client, () => {
    void refreshProfiles(); void refreshSessions(); void refreshRuns(); void projectState.refresh();
    void getModels(client).then(models => setModelOptions(models.options)).catch(() => undefined);
    if (profileName) { void getSkills(client, profileName).then(setSkills).catch(() => undefined); }
    // An open transcript belongs to this view. Remote changes are adopted only
    // when the user reloads or reopens the session.
  });

  const onLeaseLost = useCallback((error: unknown, id: string) => {
    setSessionBlocked(true);
    resetThread(id);
    handleError(error);
  }, [handleError, resetThread]);
  const { takeOver: takeOverLease } = useSessionLease(client, sessionId, onLeaseLost);

  const takeOverSession = useCallback(async () => {
    const id = sessionId;
    if (!id) { return; }
    try {
      await takeOverLease(id);
    } catch (error) {
      handleError(error);
      return;
    }
    await loadSession(id);
  }, [takeOverLease, sessionId, handleError, loadSession]);

  const selectOwner = useCallback(
    (next: ChatRoute) => {
      abortActiveChat();
      followers.stopAll();
      setSessionId(undefined);
      setSessionBlocked(false);
      resetThread();
      navigate(next);
    },
    [abortActiveChat, followers, navigate, resetThread],
  );
  const selectProfile = useCallback((name: string) => selectOwner({ view: 'agent', profile: name }), [selectOwner]);
  const selectProject = useCallback((id: string) => selectOwner({ view: 'projects', project: id }), [selectOwner]);

  const showProfiles = useCallback(() => {
    abortActiveChat();
    followers.stopAll();
    setSessionId(undefined);
    setSessionBlocked(false);
    setProfileDetail(undefined);
    setSessions([]);
    setSkills([]);
    resetThread();
    navigate(route.view === 'projects' ? { view: 'projects' } : { view: 'agent' });
    void refreshProfiles();
  }, [abortActiveChat, followers, navigate, refreshProfiles, resetThread, route.view]);

  const selectSession = useCallback(
    (id: string) => {
      if (!scopeKey || id === sessionId) { return; }
      abortActiveChat();
      setSessionId(id);
      navigate(sessionRoute(id));
      void loadSession(id);
    },
    [abortActiveChat, scopeKey, sessionId, navigate, sessionRoute, loadSession],
  );

  const newSession = useCallback(() => {
    if (!scopeKey || (sessionId && !persistedSessionIds.has(sessionId))) { return; }
    const id = createClientId();
    abortActiveChat();
    followers.stopAll();
    setSessionId(id);
    resetThread(id);
    navigate(sessionRoute(id));
    void loadSession(id);
  }, [abortActiveChat, scopeKey, followers, navigate, sessionRoute, persistedSessionIds, sessionId, resetThread, loadSession]);

  const replaceSessionSummary = useCallback((updated: SessionSummary) => {
    rememberPersistedSessionIds([updated.id]);
    setSessions(current => current
      .map(session => session.id === updated.id ? updated : session)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
        || b.updatedAt.localeCompare(a.updatedAt)));
  }, [rememberPersistedSessionIds]);

  const renameSession = useCallback(async (id: string, title: string): Promise<boolean> => {
    try {
      replaceSessionSummary(await updateSession(client, id, { title }));
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [client, handleError, replaceSessionSummary]);

  const setSessionPinned = useCallback(async (id: string, pinned: boolean): Promise<boolean> => {
    try {
      replaceSessionSummary(await updateSession(client, id, { pinned }));
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [client, handleError, replaceSessionSummary]);

  const setSessionArchived = useCallback(async (id: string, archived: boolean): Promise<boolean> => {
    try {
      await updateSession(client, id, { archived });
      setSessions(current => current.filter(session => session.id !== id));
      if (archived && id === sessionId && scopeKey) {
        abortActiveChat();
        followers.stopAll();
        setSessionId(undefined);
        resetThread();
        navigate(sessionRoute());
      }
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [abortActiveChat, client, followers, handleError, navigate, sessionRoute, scopeKey, sessionId, resetThread]);

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      const active = (await listRuns(client)).filter(run => run.sessionId === id && run.status === 'running');
      for (const run of active) { await cancelRun(client, run.id); }
      if (active.length > 0) { await waitForSessionRunsToSettle(client, id); }
      if (activeChatRef.current?.sessionId === id) { abortActiveChat(); }
      const pending = sessions.some(session => session.id === id && session.pending);
      if (!await deleteSessionWhenIdle(client, id) && !pending) { return false; }
      forgetPersistedSessionId(id);
      setSessions(current => current.filter(session => session.id !== id));
      setRuns(current => current.filter(run => run.sessionId !== id));
      if (scopeKey) {
        setAttachmentDrafts(current => {
          const next = { ...current };
          delete next[`${scopeKey}:${id}`];
          return next;
        });
      }
      if (id === sessionId && scopeKey) {
        followers.stopAll();
        setSessionId(undefined);
        resetThread();
        navigate(sessionRoute());
      }
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [abortActiveChat, client, followers, forgetPersistedSessionId, handleError, navigate, sessionRoute, scopeKey, sessionId, sessions, resetThread]);

  const moveSession = useCallback(async (id: string, target: string): Promise<boolean> => {
    try {
      await moveSessionToProject(client, id, target);
      setSessions(current => current.filter(session => session.id !== id));
      // The open conversation continues in its project; this page keeps its lease.
      if (id === sessionId) { navigate({ view: 'projects', project: target, session: id }); }
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [client, handleError, navigate, sessionId]);

  const inviteToProject = useCallback(async (name: string) => {
    if (!projectId) { return; }
    try { projectState.setProject(await inviteProjectMember(client, projectId, name)); }
    catch (error) { handleError(error); }
  }, [client, handleError, projectId, projectState.setProject]);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const result = await prepareFiles(files, attachmentsRef.current);
    for (const reason of result.rejected) {
      dispatch({ type: 'notice', tone: 'warn', text: reason });
    }
    if (result.accepted.length > 0) {
      setAttachmentDrafts(current => ({
        ...current,
        [attachmentDraftKey]: [...(current[attachmentDraftKey] ?? []), ...result.accepted],
      }));
    }
  }, [attachmentDraftKey]);

  const removeAttachment = useCallback((index: number) => {
    setAttachmentDrafts(current => ({
      ...current,
      [attachmentDraftKey]: (current[attachmentDraftKey] ?? []).filter((_, i) => i !== index),
    }));
  }, [attachmentDraftKey]);

  // The message send path (steering, session bootstrap, attachments, chat vs
  // agent). Extracted so /retry can re-run a message and send() can dispatch to
  // it after command handling. Moved verbatim — no behavior change.
  const sendMessage = useCallback(
    async (
      trimmed: string,
      options: {
        originalImages?: boolean;
        attachments?: PreparedAttachment[];
        replaceUserTurnIndex?: number;
        replaceItemId?: string;
      } = {},
    ): Promise<boolean> => {
      if (!profileName) { return false; }

      const running = activeRun(threadRef.current);
      if (running) {
        if (/(^|\s)@/.test(trimmed)) {
          dispatch({ type: 'notice', tone: 'warn', text: project
            ? 'Wait for this reply to finish, or stop it, before addressing a profile or an @device.'
            : 'Wait for this run to finish, or stop it, before starting a task on an @device.' });
          return false;
        }
        return promptQueue.enqueue(trimmed, running.runId);
      }
      if (chatResponding) { return promptQueue.enqueue(trimmed); }

      // In a project the host picks who answers; the preview sends the request's
      // model settings and skill to that profile.
      const routed = project ? previewProjectRoute(trimmed, project, floor, profiles.map(profile => profile.name)) : undefined;
      if (routed?.uninvited) {
        dispatch({ type: 'notice', tone: 'warn', text: `${routed.uninvited} isn't in this project. Invite it first.` });
        return false;
      }
      const speaker = routed?.speakers[0] ?? profileName;
      const skillText = project ? afterLeadingMentions(trimmed, project.members) : trimmed;
      let skill: ResolvedSkillInvocation | undefined;
      if (skillText.startsWith('$')) {
        if (routed && routed.speakers.length > 1) {
          dispatch({ type: 'notice', tone: 'warn', text: 'A skill runs for one profile; address a single profile.' });
          return false;
        }
        try {
          skill = await resolveSkillInvocation(client, skillText, speaker);
          // Keep the mention: the host routes by the saved message.
          skill = { ...skill, userTurn: trimmed.slice(0, trimmed.length - skillText.length) + skill.userTurn };
        } catch (error) {
          handleError(error);
          return false;
        }
        if (skill.missing.length > 0) {
          dispatch({
            type: 'notice',
            tone: 'warn',
            text: `Missing required skill value(s): ${skill.missing.join(', ')}. Usage: ${skill.usage}`,
          });
          return false;
        }
      }

      let sid = sessionId;
      if (!sid) {
        sid = createClientId();
        setSessionId(sid);
        navigate(sessionRoute(sid));
      }

      try { await acquireSessionLease(client, sid); }
      catch (error) { setSessionBlocked(true); handleError(error); return false; }

      // Consume the pending attachments: chat images ride the request natively
      // and readable text is inlined for chat parity; every agent-run upload is
      // staged read-only for inspect_attachment.
      const pending = options.attachments ?? attachmentsRef.current;
      // Ordinary Web conversations are always agent runs. The chat transport
      // remains available only for explicitly chat-mode Skills and compatibility.
      // Project replies need agent runs (one per speaker).
      const mode = project ? 'agent' : skill?.mode ?? 'agent';
      if (mode === 'chat' && pending.some(item => item.kind === 'file')) {
        dispatch({
          type: 'notice',
          tone: 'warn',
          text: 'Binary attachments require Agent mode so inspect_attachment can open them.',
        });
        return false;
      }
      if (options.originalImages) {
        const originalBytes = pending.reduce(
          (sum, item) => sum + (item.kind === 'image' ? (item.originalSize ?? item.size) : item.size),
          0,
        );
        if (originalBytes > MAX_TOTAL_BYTES) {
          dispatch({
            type: 'notice',
            tone: 'warn',
            text: `/attach-original attachments exceed the ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB request limit.`,
          });
          return false;
        }
      }
      if (options.attachments === undefined) {
        setAttachmentDrafts(current => {
          const next = { ...current };
          delete next[attachmentDraftKey];
          return next;
        });
      }
      const { images, files, prompt, durableUserTurn, bubbleAttachments } = await messagePayload(pending, {
        text: trimmed, mode, ...(skill ? { skillPrompt: skill.prompt } : {}), ...(options.originalImages ? { originalImages: true } : {}),
      });

      if (options.replaceItemId) {
        dispatch({
          type: 'edit_user_message',
          itemId: options.replaceItemId,
          text: trimmed,
          attachments: bubbleAttachments,
        });
      } else {
        dispatch({ type: 'user_message', text: trimmed, attachments: bubbleAttachments });
        setSessions(current => withPendingSession(current, {
          id: sid,
          profileName: speaker,
          prompt: trimmed,
        }));
      }
      const [provider, model] = splitModelChoice(modelChoice);
      if (mode === 'chat') {
        setSending(true);
        dispatch({ type: 'chat_started' });
        let completed = true;
        const controller = new AbortController();
        activeChatRef.current = { sessionId: sid, controller };
        setChatResponding(true);
        try {
          for await (const event of streamChat(client, {
            prompt,
            ...(skill ? {
              userTurn: skill.userTurn,
              instructions: skill.instructions,
              isolated: true,
            } : {}),
            profile: profileName,
            sessionId: sid,
            replaceUserTurnIndex: options.replaceUserTurnIndex,
            deep,
            provider,
            model,
            ...(images.length > 0 ? { images } : {}),
            ...(options.originalImages ? { originalImages: true } : {}),
          }, controller.signal)) {
            if (event.type === 'chunk') { dispatch({ type: 'chat_chunk', text: event.text }); }
            else if (event.type === 'reasoning') { dispatch({ type: 'chat_reasoning', text: event.text }); }
            else if (event.type === 'error') {
              completed = false;
              dispatch({ type: 'chat_error', message: event.message });
            }
            else { dispatch({
              type: 'chat_done',
              usage: event.usage,
              latencyMs: event.latencyMs,
            }); }
          }
          if (controller.signal.aborted) { completed = false; }
          return completed;
        } catch (error) {
          if (!controller.signal.aborted) {
            dispatch({ type: 'chat_done' });
            handleError(error);
          }
          return false;
        } finally {
          if (activeChatRef.current?.controller === controller) {
            activeChatRef.current = undefined;
            setChatResponding(false);
          }
          setSending(false);
          void refreshSessions(sid);
          if (options.replaceUserTurnIndex !== undefined) { void loadSession(sid); }
        }
      }

      try {
        setSending(true);
        // Large uploads can take a while over a workspace bridge; show that the
        // message is on its way until the host has created the run.
        setSendingBytes(prompt.length
          + images.reduce((total, image) => total + ('data' in image && image.data ? image.data.length : 0), 0)
          + files.reduce((total, file) => total + file.data.length, 0));
        const run = await startRun(client, {
          objective: prompt,
          ...(skill ? {
            userTurn: skill.userTurn,
            instructions: skill.instructions,
            lean: true,
          } : durableUserTurn ? { userTurn: durableUserTurn } : {}),
          profile: speaker,
          ...(projectId ? { projectId } : {}),
          sessionId: sid,
          replaceUserTurnIndex: options.replaceUserTurnIndex,
          deep,
          provider,
          model,
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(options.originalImages ? { originalImages: true } : {}),
        });
        dispatch({ type: 'run_created', run });
        // The host's rule: one mention takes the floor, several return it to the Lead.
        if (routed?.floor !== undefined && options.replaceUserTurnIndex === undefined) { setFloor(routed.floor ?? undefined); }
        setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
        if (options.replaceUserTurnIndex !== undefined) { editedRunIdsRef.current.add(run.id); }
        followers.attach(run.id);
        return true;
      } catch (error) {
        // The roster changed elsewhere: show it, so the composer offers the invite.
        if (error instanceof MarifoldApiError && error.code === 'PROJECT_MEMBER_REQUIRED') { void projectState.refresh(); }
        handleError(error);
        void refreshSessions(sid);
        if (options.replaceUserTurnIndex !== undefined) { void loadSession(sid); }
        return false;
      } finally {
        setSending(false);
        setSendingBytes(undefined);
      }
    },
    [client, profileName, profiles, project, projectId, projectState.refresh, floor, sessionId, sessionRoute, modelChoice, deep, followers, navigate, handleError, refreshSessions, loadSession, attachmentDraftKey, chatResponding, promptQueue.enqueue],
  );

  const stop = useCallback(async (): Promise<boolean> => {
    if (abortActiveChat()) {
      dispatch({ type: 'chat_cancelled' });
      return true;
    }
    const running = activeRun(threadRef.current);
    if (!running) { return false; }
    try {
      await cancelRun(client, running.runId);
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [abortActiveChat, client, handleError]);

  const runCommand = useCallback(
    (command: { name: string; args: string }) => runAgentCommand({
      client, dispatch, threadRef, profileName, profileDetail, modelChoice, deep, sessionId,
      newSession, setDeep, setModelChoice, sendMessage, refreshSessions, handleError, stop,
      project, onProjectChange: projectState.setProject,
    }, command),
    [client, profileName, profileDetail, modelChoice, deep, sessionId, newSession, setDeep, setModelChoice, setProfileDetail, sendMessage, refreshSessions, handleError, stop, project, projectState.setProject],
  );

  // `/command` is a deterministic web action, handled before steering so e.g.
  // `/stop` cancels a run instead of steering it; everything else sends.
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !profileName) { return; }
      const command = parseCommand(trimmed);
      if (command) {
        await runCommand(command);
        return;
      }
      await sendMessage(trimmed);
    },
    [profileName, runCommand, sendMessage],
  );

  const resendEdited = useCallback(
    async (userItemId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) { return false; }
      const items = threadRef.current.items;
      const itemIndex = items.findIndex(item => item.id === userItemId);
      const target = items[itemIndex];
      if (itemIndex === -1 || !target || target.kind !== 'user') {
        dispatch({ type: 'notice', tone: 'warn', text: 'That message is no longer available to edit.' });
        return false;
      }

      const priorPersistedUsers = items.slice(0, itemIndex).filter(
        item => item.kind === 'user' && item.sessionUserTurnIndex !== undefined,
      ).length;
      const fromUserTurnIndex = target.sessionUserTurnIndex ?? priorPersistedUsers;
      const durable = target.sessionUserTurnIndex !== undefined;
      const restoredAttachments = await preparedAttachmentsFromUser(target.attachments, client);

      setSending(true);
      try {
        if (durable && !sessionId) { throw new Error('Cannot edit durable history without a session.'); }
        if ((target.attachments?.length ?? 0) > restoredAttachments.length) {
          dispatch({
            type: 'notice',
            tone: 'warn',
            text: 'Only retained image attachments could be included with the edited message.',
          });
        }
        if (!durable) { dispatch({ type: 'discard_from', itemId: userItemId }); }
        const sent = await sendMessage(trimmed, {
          attachments: restoredAttachments,
          ...(durable ? { replaceUserTurnIndex: fromUserTurnIndex, replaceItemId: userItemId } : {}),
        });
        if (!sent && durable && sessionId) { await loadSession(sessionId); }
        return sent;
      } catch (error) {
        handleError(error);
        return false;
      } finally {
        setSending(false);
      }
    },
    [sessionId, sendMessage, loadSession, handleError],
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
    async (runId: string, requestId: string, action: RunApprovalAction, sudoResponse?: SudoResponse) => {
      dispatch({ type: 'approval_submitting', runId });
      try {
        await answerApproval(client, runId, requestId, action, sudoResponse);
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

  const answerInput = useCallback(
    async (runId: string, requestId: string, submission: UserInputSubmission) => {
      dispatch({ type: 'user_input_submitting', runId });
      try {
        await answerUserInput(client, runId, requestId, submission);
        // user_input_response on the stream archives the answers and clears the form.
      } catch (error) {
        const gone = error instanceof MarifoldApiError && error.code === 'USER_INPUT_NOT_FOUND';
        dispatch({
          type: 'user_input_failed',
          runId,
          gone,
          message: gone
            ? 'Those questions already resolved (answered elsewhere or timed out).'
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
      seenRuns.add(run.id);
      dispatch({ type: 'run_created', run: { ...run, status: 'running' } });
      // Replay the finished stream from the start; it closes after done.
      followers.attach(run.id, 0);
      dispatch({ type: 'dismiss_catch_up', runId: run.id });
    },
    [followers, seenRuns],
  );

  const dismissCatchUp = useCallback(() => {
    for (const run of threadRef.current.catchUp) {
      seenRuns.add(run.id);
    }
    dispatch({ type: 'dismiss_catch_up' });
  }, [seenRuns]);

  return {
    profiles,
    profileName,
    project,
    projectMissing: projectState.missing,
    floor,
    selectProject,
    refreshProject: projectState.refresh,
    inviteToProject,
    moveSession,
    profileDetail,
    skills,
    devices,
    sessions,
    sessionSearch,
    setSessionSearch,
    showArchivedSessions,
    setShowArchivedSessions,
    runningSessionIds: new Set([
      ...runs.filter(run => run.status === 'running' && run.sessionId).map(run => run.sessionId!),
      ...(sending && sessionId ? [sessionId] : []),
    ]),
    sessionId,
    thread,
    sessionLoading,
    sessionBlocked,
    takeOverSession,
    sendingBytes,
    profilesLoading,
    sessionsLoading,
    steeringRun: activeRun(thread)?.runId,
    promptQueue,
    responding: chatResponding || activeRun(thread) !== undefined,
    sending,
    deep,
    setDeep,
    modelOptions,
    modelChoice,
    setModelChoice,
    attachments,
    addFiles,
    removeAttachment,
    send,
    resendEdited,
    refreshProfiles,
    setProfilePinned,
    showProfiles,
    selectProfile,
    selectSession,
    newSession,
    renameSession,
    setSessionPinned,
    setSessionArchived,
    deleteSession,
    cancel,
    stop,
    answer,
    answerInput,
    toggleRun,
    expandCatchUp,
    dismissCatchUp,
  };
}
