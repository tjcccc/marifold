import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { streamChat } from '../../api/chat';
import { getModels, getSkills, resolveSkillInvocation } from '../../api/misc';
import type { ResolvedSkillInvocation, SkillHint } from '../../api/misc';
import {
  deleteMemory,
  getProfile,
  listMemories,
  listProfiles,
  rememberMemory,
  setProfilePinned as setProfilePinnedRequest,
  updateProfile,
} from '../../api/profiles';
import { answerApproval, cancelRun, listRuns, startRun, steerRun } from '../../api/runs';
import {
  compactSession,
  deleteSession as deleteSessionRequest,
  getSession,
  listSessions,
  updateSession,
} from '../../api/sessions';
import type {
  ProfileDetail,
  ProfileSummary,
  RunApprovalAction,
  RunFileInput,
  RunRecord,
  SessionImageAttachment,
  SessionSummary,
} from '../../api/types';
import type { Route } from '../../lib/route';
import type { PreparedAttachment } from '../../lib/attachments';
import {
  fileToBase64,
  inlineTextAttachments,
  MAX_TOTAL_BYTES,
  officeKindForFile,
  prepareFiles,
  splitInlineTextAttachments,
} from '../../lib/attachments';
import { parseCommand, WEB_COMMANDS } from '../../lib/commandSyntax';
import { withPendingSession } from '../../lib/sessionSummaries';
import { RunFollowers } from '../../state/followers';
import type { ThreadState, UserAttachment } from '../../state/thread';
import { activeRun, createThreadState, threadReducer } from '../../state/thread';

const RUN_POLL_INTERVAL_MS = 10_000;
const RUN_SETTLE_POLL_MS = 75;
const RUN_SETTLE_TIMEOUT_MS = 15_000;

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
  /** Skills for the composer's $-autocomplete (active-profile-scoped). */
  skills: SkillHint[];
  sessions: SessionSummary[];
  sessionSearch: string;
  setSessionSearch: (value: string) => void;
  showArchivedSessions: boolean;
  setShowArchivedSessions: (value: boolean) => void;
  runningSessionIds: ReadonlySet<string>;
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
  const [skills, setSkills] = useState<SkillHint[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionSearch, setSessionSearch] = useState('');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(route.session);
  const [think, setThink] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelChoice, setModelChoice] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const [thread, dispatch] = useReducer(threadReducer, undefined, () => createThreadState(route.session));
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const profileName = route.profile;
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, PreparedAttachment[]>>({});
  const attachmentDraftKey = `${profileName ?? '_'}:${sessionId ?? 'new'}`;
  const attachments = attachmentDrafts[attachmentDraftKey] ?? [];
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const refreshSessionsRef = useRef<() => void>(() => undefined);
  const refreshRunsRef = useRef<() => void>(() => undefined);
  const reloadSessionRef = useRef<() => void>(() => undefined);
  const editedRunIdsRef = useRef(new Set<string>());
  const ignoredFinishedRunIdsRef = useRef(new Set<string>());
  const activeChatRef = useRef<{ sessionId: string; controller: AbortController } | undefined>(undefined);
  const abortActiveChat = useCallback(() => {
    activeChatRef.current?.controller.abort();
    activeChatRef.current = undefined;
  }, []);
  const followers = useMemo(
    () => new RunFollowers(client, dispatch, runId => {
      refreshSessionsRef.current();
      refreshRunsRef.current();
      if (editedRunIdsRef.current.delete(runId)) {
        ignoredFinishedRunIdsRef.current.add(runId);
        reloadSessionRef.current();
      }
    }),
    [client],
  );
  useEffect(() => () => followers.stopAll(), [followers]);
  useEffect(() => () => abortActiveChat(), [abortActiveChat]);

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
      setRuns(runs);
      const mine = runs.filter(
        run => run.sessionId === forSession && !ignoredFinishedRunIdsRef.current.has(run.id),
      );
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
          turns: detail.turns.map(turn => {
            if (turn.role === 'assistant') return { role: turn.role, content: turn.content };
            const restored = splitInlineTextAttachments(turn.content);
            const attachments: UserAttachment[] = [
              ...toUserAttachments(id, turn.attachments ?? []),
              ...restored.files.map(file => {
                const officeKind = officeKindForFile(file.name);
                return {
                  kind: 'text' as const,
                  name: file.name,
                  content: file.content,
                  ...(officeKind ? { officeKind } : {}),
                  ...(file.content.includes('[Office extraction truncated to fit the attachment text limit.]')
                    ? { truncated: true }
                    : {}),
                };
              }),
            ];
            return {
              role: turn.role,
              content: restored.prompt,
              ...(attachments.length > 0 ? { attachments } : {}),
            };
          }),
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

  // Bootstrap the profile list and model options. The root Agent route stays
  // on the profile picker; only an explicit route selects a profile.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profileList, models] = await Promise.all([
          listProfiles(client),
          getModels(client),
        ]);
        if (cancelled) return;
        setProfiles(profileList);
        setModelOptions(models.options);
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, handleError]);

  // Profile selection → detail + think default.
  useEffect(() => {
    if (!profileName) return;
    let cancelled = false;
    (async () => {
      try {
        const [detail, skillList] = await Promise.all([
          getProfile(client, profileName),
          getSkills(client, profileName).catch(() => [] as SkillHint[]),
        ]);
        if (cancelled) return;
        setProfileDetail(detail);
        setSkills(skillList);
        setThink(detail.settings.think ?? false);
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, profileName, handleError]);

  // Session search/archive filters are server-backed so results are not
  // limited to whichever 50 rows happened to load first.
  useEffect(() => {
    if (!profileName) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      listSessions(client, {
        profile: profileName,
        limit: 100,
        archived: showArchivedSessions,
        search: sessionSearch,
      }).then(result => {
        if (!cancelled) setSessions(result);
      }).catch(error => {
        if (!cancelled) handleError(error);
      });
    }, sessionSearch ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, handleError, profileName, sessionSearch, showArchivedSessions]);

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

  const refreshSessions = useCallback(async () => {
    if (!profileName) return;
    try {
      setSessions(await listSessions(client, {
        profile: profileName,
        limit: 100,
        archived: showArchivedSessions,
        search: sessionSearch,
      }));
    } catch {
      // List refresh is cosmetic; ignore failures.
    }
  }, [client, profileName, sessionSearch, showArchivedSessions]);
  refreshSessionsRef.current = () => { void refreshSessions(); };
  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await listRuns(client));
    } catch {
      // Run status is advisory UI state; the service remains authoritative.
    }
  }, [client]);
  refreshRunsRef.current = () => { void refreshRuns(); };
  reloadSessionRef.current = () => { if (sessionId) void loadSession(sessionId); };

  const selectProfile = useCallback(
    (name: string) => {
      abortActiveChat();
      followers.stopAll();
      setSessionId(undefined);
      dispatch({ type: 'reset' });
      navigate({ view: 'agent', profile: name });
    },
    [abortActiveChat, followers, navigate],
  );

  const showProfiles = useCallback(() => {
    abortActiveChat();
    followers.stopAll();
    setSessionId(undefined);
    setProfileDetail(undefined);
    setSessions([]);
    setSkills([]);
    dispatch({ type: 'reset' });
    navigate({ view: 'agent' });
    void refreshProfiles();
  }, [abortActiveChat, followers, navigate, refreshProfiles]);

  const selectSession = useCallback(
    (id: string) => {
      if (!profileName || id === sessionId) return;
      abortActiveChat();
      setSessionId(id);
      navigate({ view: 'agent', profile: profileName, session: id });
      void loadSession(id);
    },
    [abortActiveChat, profileName, sessionId, navigate, loadSession],
  );

  const newSession = useCallback(() => {
    if (!profileName) return;
    const id = crypto.randomUUID();
    abortActiveChat();
    followers.stopAll();
    setSessionId(id);
    dispatch({ type: 'reset', sessionId: id });
    navigate({ view: 'agent', profile: profileName, session: id });
  }, [abortActiveChat, profileName, followers, navigate]);

  const replaceSessionSummary = useCallback((updated: SessionSummary) => {
    setSessions(current => current
      .map(session => session.id === updated.id ? updated : session)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
        || b.updatedAt.localeCompare(a.updatedAt)));
  }, []);

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
      if (archived && id === sessionId && profileName) {
        abortActiveChat();
        followers.stopAll();
        setSessionId(undefined);
        dispatch({ type: 'reset' });
        navigate({ view: 'agent', profile: profileName });
      }
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [abortActiveChat, client, followers, handleError, navigate, profileName, sessionId]);

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      const active = (await listRuns(client)).filter(run => run.sessionId === id && run.status === 'running');
      for (const run of active) await cancelRun(client, run.id);
      if (active.length > 0) await waitForSessionRunsToSettle(client, id);
      if (activeChatRef.current?.sessionId === id) abortActiveChat();
      const pending = sessions.some(session => session.id === id && session.pending);
      if (!await deleteSessionWhenIdle(client, id) && !pending) return false;
      setSessions(current => current.filter(session => session.id !== id));
      setRuns(current => current.filter(run => run.sessionId !== id));
      if (profileName) {
        setAttachmentDrafts(current => {
          const next = { ...current };
          delete next[`${profileName}:${id}`];
          return next;
        });
      }
      if (id === sessionId && profileName) {
        followers.stopAll();
        setSessionId(undefined);
        dispatch({ type: 'reset' });
        navigate({ view: 'agent', profile: profileName });
      }
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }, [abortActiveChat, client, followers, handleError, navigate, profileName, sessionId, sessions]);

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
      if (!profileName) return false;

      const running = activeRun(threadRef.current);
      if (running) {
        try {
          await steerRun(client, running.runId, trimmed);
          return true;
        } catch (error) {
          handleError(error);
          return false;
        }
      }

      let skill: ResolvedSkillInvocation | undefined;
      if (trimmed.startsWith('$')) {
        try {
          skill = await resolveSkillInvocation(client, trimmed, profileName);
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
        sid = crypto.randomUUID();
        setSessionId(sid);
        navigate({ view: 'agent', profile: profileName, session: sid });
      }

      // Consume the pending attachments: images ride the request natively,
      // text files are inlined into the prompt as fenced blocks.
      const pending = options.attachments ?? attachmentsRef.current;
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
      const imageAttachments = pending.filter(
        (item): item is Extract<PreparedAttachment, { kind: 'image' }> => item.kind === 'image',
      );
      const images = await Promise.all(imageAttachments.map(async item => (
        options.originalImages && item.originalFile
          ? { data: await fileToBase64(item.originalFile), mediaType: item.originalFile.type || item.mediaType }
          : { data: item.data, mediaType: item.mediaType }
      )));
      const textFiles = pending.filter(
        (item): item is Extract<PreparedAttachment, { kind: 'text' }> => item.kind === 'text',
      );
      const files: RunFileInput[] = await Promise.all(textFiles.flatMap(item => {
        if (item.officeKind && !item.originalFile) return [];
        const source = item.originalFile ?? new Blob([item.content], { type: item.mediaType || 'text/plain' });
        return [fileToBase64(source).then(data => ({
          name: item.name,
          mediaType: item.mediaType || source.type || 'text/plain',
          data,
        }))];
      }));
      const prompt = inlineTextAttachments(skill?.prompt ?? trimmed, textFiles);
      const bubbleAttachments: UserAttachment[] = pending.map(item =>
        item.kind === 'image'
          ? { kind: 'image', name: item.name, previewUrl: `data:${item.mediaType};base64,${item.data}` }
          : {
              kind: 'text',
              name: item.name,
              content: item.content,
              ...(item.officeKind ? { officeKind: item.officeKind } : {}),
              ...(item.truncated ? { truncated: true } : {}),
            },
      );

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
          profileName,
          prompt: trimmed,
        }));
      }
      const [provider, model] = splitModelChoice(modelChoice);
      const mode = skill?.mode ?? profileDetail?.settings.mode ?? 'agent';

      if (mode === 'chat') {
        setSending(true);
        dispatch({ type: 'chat_started' });
        let completed = true;
        const controller = new AbortController();
        activeChatRef.current = { sessionId: sid, controller };
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
            think,
            provider,
            model,
            ...(images.length > 0 ? { images } : {}),
            ...(options.originalImages ? { originalImages: true } : {}),
          }, controller.signal)) {
            if (event.type === 'chunk') dispatch({ type: 'chat_chunk', text: event.text });
            else if (event.type === 'reasoning') dispatch({ type: 'chat_reasoning', text: event.text });
            else if (event.type === 'error') {
              completed = false;
              dispatch({ type: 'chat_error', message: event.message });
            }
            else dispatch({ type: 'chat_done' });
          }
          if (controller.signal.aborted) completed = false;
          return completed;
        } catch (error) {
          dispatch({ type: 'chat_done' });
          if (!controller.signal.aborted) handleError(error);
          return false;
        } finally {
          if (activeChatRef.current?.controller === controller) activeChatRef.current = undefined;
          setSending(false);
          void refreshSessions();
          if (options.replaceUserTurnIndex !== undefined) void loadSession(sid);
        }
      }

      try {
        setSending(true);
        const run = await startRun(client, {
          objective: prompt,
          ...(skill ? {
            userTurn: skill.userTurn,
            instructions: skill.instructions,
            lean: true,
          } : {}),
          profile: profileName,
          sessionId: sid,
          replaceUserTurnIndex: options.replaceUserTurnIndex,
          think,
          provider,
          model,
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(options.originalImages ? { originalImages: true } : {}),
        });
        dispatch({ type: 'run_created', run });
        setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
        if (options.replaceUserTurnIndex !== undefined) editedRunIdsRef.current.add(run.id);
        followers.attach(run.id);
        return true;
      } catch (error) {
        handleError(error);
        void refreshSessions();
        if (options.replaceUserTurnIndex !== undefined) void loadSession(sid);
        return false;
      } finally {
        setSending(false);
      }
    },
    [client, profileName, sessionId, modelChoice, think, profileDetail, followers, navigate, handleError, refreshSessions, loadSession, attachmentDraftKey],
  );

  const runCommand = useCallback(
    async ({ name, args }: { name: string; args: string }) => {
      const notify = (text: string, tone: 'info' | 'warn' | 'error' = 'info') =>
        dispatch({ type: 'notice', tone, text });
      switch (name) {
        case 'help':
          notify(WEB_COMMANDS.map(command => `${command.usage} — ${command.description}`).join('\n'));
          break;
        case 'status':
          notify([
            `Profile: ${profileName ?? '—'}`,
            `Mode: ${profileDetail?.settings.mode ?? 'agent'}`,
            `Model: ${modelChoice ?? 'Auto (profile default)'}`,
            `Thinking: ${think ? 'on' : 'off'}`,
            `Session: ${sessionId ?? 'new'}`,
          ].join('\n'));
          break;
        case 'copy': {
          const last = [...threadRef.current.items].reverse().find(item => item.kind === 'assistant');
          const text = last && last.kind === 'assistant' ? last.markdown : '';
          if (!text) { notify('Nothing to copy yet.'); break; }
          try {
            await navigator.clipboard.writeText(text);
            notify('Copied the last response to the clipboard.');
          } catch {
            notify('Clipboard is unavailable in this browser context.', 'warn');
          }
          break;
        }
        case 'retry': {
          const lastUser = [...threadRef.current.items].reverse().find(item => item.kind === 'user');
          const text = lastUser && lastUser.kind === 'user' ? lastUser.text : '';
          if (!text) { notify('No previous message to retry.'); break; }
          await sendMessage(text);
          break;
        }
        case 'attach-original':
          if (!args) notify('Usage: /attach-original <prompt>', 'warn');
          else if (activeRun(threadRef.current)) notify('A task is running. Stop it before sending attached images.', 'warn');
          else await sendMessage(args, { originalImages: true });
          break;
        case 'new':
          newSession();
          break;
        case 'agent':
        case 'chat': {
          if (!profileName) break;
          try {
            const detail = await updateProfile(client, profileName, { mode: name as 'agent' | 'chat' });
            setProfileDetail(detail);
            notify(`Profile mode set to ${name} (saved to the profile).`);
          } catch (error) {
            handleError(error);
          }
          break;
        }
        case 'think':
          setThink(!think);
          notify(`Thinking mode ${think ? 'off' : 'on'}.`);
          break;
        case 'model':
          if (args) {
            setModelChoice(args);
            notify(`Model set to ${args}.`);
          } else {
            notify('Usage: /model <provider/model>, e.g. /model xai/grok-4.5', 'warn');
          }
          break;
        case 'btw': {
          if (!args) { notify('Usage: /btw <text>', 'warn'); break; }
          const active = activeRun(threadRef.current);
          if (active) await steerRun(client, active.runId, args).catch(handleError);
          else notify('No task is running to steer.');
          break;
        }
        case 'stop': {
          const active = activeRun(threadRef.current);
          if (active) await cancelRun(client, active.runId).catch(handleError);
          else notify('No task is running.');
          break;
        }
        case 'remember': {
          if (!profileName || !args) { notify('Usage: /remember <text>', 'warn'); break; }
          try {
            await rememberMemory(client, profileName, args);
            notify('Saved to memory.');
          } catch (error) {
            handleError(error);
          }
          break;
        }
        case 'forget': {
          if (!profileName || !args) { notify('Usage: /forget <query>', 'warn'); break; }
          try {
            const memories = await listMemories(client, profileName);
            const query = args.toLowerCase();
            const matches = memories.filter(memory => memory.text.toLowerCase().includes(query));
            if (matches.length === 0) { notify(`No memories match "${args}".`); break; }
            for (const memory of matches) await deleteMemory(client, profileName, memory.id, 'forget');
            notify(`Forgot ${matches.length} ${matches.length === 1 ? 'memory' : 'memories'}.`);
          } catch (error) {
            handleError(error);
          }
          break;
        }
        case 'context-window': {
          const budget = profileDetail?.settings.maxContextTokens;
          const window = profileDetail?.settings.sessionContextTurns;
          notify([
            `Context budget: ${budget !== undefined ? `${budget} tokens` : 'default'}`,
            `Turn window: ${window !== undefined ? `${window} turns` : 'all'}`,
            'Change these in Config → the profile.',
          ].join('\n'));
          break;
        }
        case 'compact': {
          if (!sessionId) { notify('No session to compact yet.'); break; }
          const [provider, model] = splitModelChoice(modelChoice);
          try {
            const result = await compactSession(client, sessionId, {
              profile: profileName ?? 'default',
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
              think,
            });
            notify(result.compacted ? 'Compacted older turns in this session.' : 'Nothing to compact yet.');
            void refreshSessions();
          } catch (error) {
            handleError(error);
          }
          break;
        }
        default:
          notify(`Unknown command: /${name}`, 'warn');
      }
    },
    [client, profileName, profileDetail, modelChoice, think, sessionId, newSession, setThink, setModelChoice, setProfileDetail, sendMessage, refreshSessions, handleError],
  );

  // `/command` is a deterministic web action, handled before steering so e.g.
  // `/stop` cancels a run instead of steering it; everything else sends.
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !profileName) return;
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
      if (!trimmed) return false;
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
        if (durable && !sessionId) throw new Error('Cannot edit durable history without a session.');
        if ((target.attachments?.length ?? 0) > restoredAttachments.length) {
          dispatch({
            type: 'notice',
            tone: 'warn',
            text: 'Only retained image attachments could be included with the edited message.',
          });
        }
        if (!durable) dispatch({ type: 'discard_from', itemId: userItemId });
        const sent = await sendMessage(trimmed, {
          attachments: restoredAttachments,
          ...(durable ? { replaceUserTurnIndex: fromUserTurnIndex, replaceItemId: userItemId } : {}),
        });
        if (!sent && durable && sessionId) await loadSession(sessionId);
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
    skills,
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
    steeringRun: activeRun(thread)?.runId,
    sending,
    think,
    setThink,
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
    answer,
    toggleRun,
    expandCatchUp,
    dismissCatchUp,
  };
}

function parseImageDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

async function waitForSessionRunsToSettle(client: ApiClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const active = (await listRuns(client)).some(
      run => run.sessionId === sessionId && run.status === 'running',
    );
    if (!active) return;
    await new Promise(resolve => window.setTimeout(resolve, RUN_SETTLE_POLL_MS));
  }
  throw new Error('The active run did not stop in time. The session was not deleted.');
}

async function deleteSessionWhenIdle(client: ApiClient, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await deleteSessionRequest(client, sessionId);
    } catch (error) {
      if (!(error instanceof MarifoldApiError && error.code === 'AGENT_RUN_INVALID')) throw error;
      await new Promise(resolve => window.setTimeout(resolve, RUN_SETTLE_POLL_MS));
    }
  }
  throw new Error('The active request did not stop in time. The session was not deleted.');
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

async function preparedAttachmentsFromUser(
  items: UserAttachment[] | undefined,
  client: ApiClient,
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const attachment of items ?? []) {
    if (attachment.kind === 'text') {
      if (attachment.content === undefined) continue;
      prepared.push({
        kind: 'text',
        name: attachment.name,
        size: new TextEncoder().encode(attachment.content).length,
        content: attachment.content,
        ...(attachment.officeKind ? { officeKind: attachment.officeKind } : {}),
        ...(attachment.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    let parsed = attachment.previewUrl ? parseImageDataUrl(attachment.previewUrl) : undefined;
    if (!parsed && attachment.sourcePath) {
      const blob = await client.blob(attachment.sourcePath);
      if (blob) parsed = { mediaType: blob.type || 'image/jpeg', data: await blobToBase64(blob) };
    }
    if (!parsed) continue;
    const size = base64ByteLength(parsed.data);
    prepared.push({
      kind: 'image' as const,
      name: attachment.name,
      size,
      originalSize: size,
      optimized: false,
      data: parsed.data,
      mediaType: parsed.mediaType,
    });
  }
  return prepared;
}

function toUserAttachments(sessionId: string, attachments: SessionImageAttachment[]): UserAttachment[] {
  return attachments.flatMap((attachment, index) => {
    const previewUrl = attachment.data
      ? `data:${attachment.mediaType};base64,${attachment.data}`
      : attachment.url;
    const sourcePath = attachment.ref
      ? `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${attachment.ref.userTurnIndex}/${attachment.ref.attachmentIndex}`
      : undefined;
    return previewUrl || sourcePath
      ? [{
          kind: 'image' as const,
          name: `Image ${index + 1}`,
          ...(previewUrl ? { previewUrl } : {}),
          ...(sourcePath ? { sourcePath } : {}),
        }]
      : [];
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function splitModelChoice(choice?: string): [string | undefined, string | undefined] {
  if (!choice) return [undefined, undefined];
  const slash = choice.indexOf('/');
  if (slash === -1) return [undefined, choice];
  return [choice.slice(0, slash), choice.slice(slash + 1)];
}
