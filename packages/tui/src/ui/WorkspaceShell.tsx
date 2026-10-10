import { sessionPromptHistory } from '../core/promptHistory.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { createApiClient, isSessionBusy, startupWorkspaces, type ApiClientOptions } from '@marifold/client';
import type { MarifoldRuntime } from '@marifold/core';
import type { WorkspaceSummary, WorkspaceDevice, LoadedMarifoldConfig } from '@marifold/core';
import { RemoteRuntime } from '../core/RemoteRuntime.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { App, type AppProps } from './App.js';
import { sessionBusyText } from './appHelpers.js';

interface Props {
  local: MarifoldRuntime;
  loadedConfig: LoadedMarifoldConfig;
  service: ApiClientOptions;
  profile?: string;
  resume?: string | boolean;
  /** Take the resumed session over from another device or page. */
  takeover?: boolean;
  /** Open the first session on the recent-session picker. */
  sessions?: boolean;
  version: string;
  fullscreen?: boolean;
}
interface Entry {
  key: string;
  runtime: TuiRuntime;
  config: LoadedMarifoldConfig;
  initial: AppProps['initial'];
  name: string;
}
export function WorkspaceShell(props: Props) {
  const [entry, setEntry] = useState<Entry>();
  const { exit } = useApp();
  const [notice, setNotice] = useState('Connecting to workspace…');
  const selected = useRef<string>('local');
  const execution = useRef<string | undefined>(undefined);
  const localApi = useRef(createApiClient(props.service)).current;
  const serial = useRef(0);
  const load = useCallback(
    async (id: string, resume?: string | boolean, takeover = false, pickSession = false): Promise<void> => {
      const version = ++serial.current;
      let runtime: TuiRuntime = props.local;
      let config = props.loadedConfig;
      let name = 'Local';
      if (id !== 'local') {
        const result = await localApi.request<{ workspaces: WorkspaceSummary[] }>('GET', '/v1/workspaces');
        const candidates = result.workspaces.filter((w) => w.id === id || w.name === id);
        if (candidates.length !== 1) {
          throw new Error(candidates.length ? 'Workspace name is ambiguous; use its ID.' : 'Workspace not found.');
        }
        const workspace = candidates[0]!;
        if (!workspace.online) { throw new Error('Workspace host is offline.'); }
        id = workspace.id;
        name = workspace.name;
        const remote = new RemoteRuntime({
          ...props.service,
          workspaceId: id,
          executionDevice: () => execution.current,
        });
        await remote.refresh();
        runtime = remote;
        config = remote.loadedConfig;
      }
      // A named session must exist here; it also selects its own profile
      // unless --profile names one.
      let requested;
      if (typeof resume === 'string') {
        // A remote host refuses to read a session another client holds, so
        // `--takeover` moves it here first and then reads it.
        try { requested = await findSession(runtime, resume); }
        catch (error) {
          if (!takeover || !isSessionBusy(error)) { throw new Error(sessionBusyText(error, resume)); }
          await runtime.takeOverSession?.(resume);
          requested = await findSession(runtime, resume);
        }
        if (!requested) { throw new Error(`Session ${resume} was not found in the ${name} workspace.`); }
        if (props.profile && props.profile !== requested.profileName) {
          throw new Error(`Session ${resume} belongs to profile "${requested.profileName}". Resume it without --profile or with --profile ${requested.profileName}.`);
        }
      }
      const profile = props.profile ?? requested?.profileName;
      let settings;
      try {
        settings = runtime.resolveSettings({ profile });
      } catch {
        if (id !== 'local') { throw new Error('Choose a profile with a configured model on this workspace.'); }
        settings = { profile: profile ?? config.config.default.profile, provider: '', model: '(configure a model)', think: false };
      }
      let sessionId = requested?.id;
      if (resume === true) {
        sessionId = (await runtime.listSessions(1, settings.profile, { order: 'recent' }))[0]?.id;
      }
      if (sessionId) {
        try {
          if (takeover) { await runtime.takeOverSession?.(sessionId); }
          else { await runtime.acquireSession?.(sessionId); }
        } catch (error) {
          throw new Error(sessionBusyText(error, sessionId));
        }
      }
      // Read the transcript after acquiring, so a takeover sees the latest turns.
      const session = sessionId ? await findSession(runtime, sessionId) : undefined;
      if (version !== serial.current) { return; }
      selected.current = id;
      execution.current = undefined;
      let displayName: string | undefined;
      try {
        displayName = runtime.getProfile(settings.profile).displayName;
      } catch {
        /* A new local configuration may have no profiles. */
      }
      setEntry({
        key: `${id}:${version}`,
        runtime,
        config,
        name,
        initial: {
          profile: settings.profile,
          displayName,
          provider: settings.provider,
          model: settings.model,
          think: settings.think,
          version: props.version,
          cwd: id === 'local' ? process.cwd() : `Workspace: ${name}`,
          sessionId: session?.id,
          history: session ? sessionPromptHistory(session) : [],
          transcript: session?.turns.map((t) => ({ kind: t.role, text: t.content })),
          ...(pickSession ? { pickSession: true } : {}),
        },
      });
      setNotice(`${name} workspace · /workspace list · /device list`);
    },
    [localApi, props.local, props.loadedConfig, props.profile, props.service, props.version],
  );
  useEffect(() => {
    let alive = true;
    void (async () => {
      let target = 'local';
      let fallback: string | undefined;
      let offline: WorkspaceSummary | undefined;
      try {
        const result = await startupWorkspaces<WorkspaceSummary>(localApi);
        const workspace = result.workspaces.find((w) => w.id === result.defaultId && w.online);
        target = workspace?.id ?? 'local';
        if (result.defaultId !== 'local' && !workspace) {
          offline = result.workspaces.find((w) => w.id === result.defaultId);
          fallback = 'Default workspace is offline. Opened Local for this launch.';
        }
      } catch {
        fallback = 'Workspace service unavailable. Opened Local.';
      }
      if (!alive) { return; }
      // `--resume` and `--sessions` ask for the default workspace's sessions;
      // Local's sessions are not a stand-in for them.
      if (offline && (props.resume !== undefined || props.sessions)) {
        exit(new Error(`Workspace "${offline.name}" is offline. Try again when its host is online.`));
        return;
      }
      try {
        try {
          await load(target, props.resume, props.takeover, props.sessions);
        } catch (error) {
          // A resumed session or the session picker opens exactly as asked or
          // not at all: never an empty session, and never Local in place of the workspace.
          if (props.resume !== undefined || props.sessions || target === 'local') { throw error; }
          await load('local');
          fallback = 'Workspace service unavailable. Opened Local.';
        }
        if (alive && fallback) { setNotice(fallback); }
      } catch (error) {
        if (alive) { exit(error instanceof Error ? error : new Error(String(error))); }
      }
    })();
    return () => {
      alive = false;
      serial.current++;
    };
  }, []);
  useEffect(() => {
    if (!(entry?.runtime instanceof RemoteRuntime)) { return; }
    const remote = entry.runtime;
    let busy = false;
    let alive = true;
    let revision: string | undefined;
    const timer = setInterval(() => {
      if (busy) { return; }
      busy = true;
      void remote.api
        .request<{ revision: string }>('GET', '/v1/changes')
        .then(async (result) => {
          if (revision !== result.revision) {
            await remote.refresh();
            revision = result.revision;
            if (alive) {
              setEntry((current) =>
                current?.runtime === remote ? { ...current, config: remote.loadedConfig } : current,
              );
            }
          }
        })
        .catch(() => {
          if (alive) { setNotice(`${entry.name} is unavailable. This conversation stays in its workspace.`); }
        })
        .finally(() => {
          busy = false;
        });
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [entry?.key]);
  const workspaceCommand = async (args: string) => {
    const [operation, ...parts] = args.trim().split(/\s+/);
    if (operation === 'leave') {
      await load('local', true);
      return 'Returned to Local.';
    }
    if (operation === 'join' && parts.length) {
      await load(parts.join(' '));
      return 'Workspace opened.';
    }
    if (!operation || operation === 'list') {
      const result = await localApi.request<{ workspaces: WorkspaceSummary[] }>('GET', '/v1/workspaces');
      return [
        'Local · /workspace leave',
        ...result.workspaces.map((w) => `${w.name} · ${w.id} · ${w.online ? 'online' : 'offline'}`),
      ].join('\n');
    }
    return 'Usage: /workspace list | join <name|id> | leave';
  };
  const deviceCommand = async (args: string) => {
    if (selected.current === 'local') {
      return 'Local tools run on this device. Join a workspace to select another device.';
    }
    const { devices } = await localApi.request<{ devices: WorkspaceDevice[] }>(
      'POST',
      `/v1/workspaces/${selected.current}/manage/devices`,
      {},
    );
    const [operation, value] = args.trim().split(/\s+/);
    if (operation === 'use' && value) {
      if (!['auto', 'host'].includes(value) && !devices.some((d) => d.id === value && d.online && d.executor)) {
        throw new Error('Device is unavailable or has not enabled execution.');
      }
      execution.current = value === 'auto' ? undefined : value;
      setNotice(`${entry?.name} workspace · tools: ${value}`);
      return `Next run uses ${value}. Skills always use the host.`;
    }
    return devices
      .map(
        (d) => `${d.name} · ${d.id} · ${d.online ? 'online' : 'offline'} · ${d.executor ? 'executor' : 'viewing only'}`,
      )
      .join('\n');
  };
  return (
    <Box flexDirection="column">
      {!props.fullscreen || !entry ? <Text dimColor>{notice}</Text> : null}
      {entry && (
        <App
          key={entry.key}
          fullscreen={props.fullscreen}
          workspaceNotice={props.fullscreen ? notice : undefined}
          runtime={entry.runtime}
          loadedConfig={entry.config}
          initial={entry.initial}
          workspaceCommand={workspaceCommand}
          deviceCommand={deviceCommand}
        />
      )}
    </Box>
  );
}

/** A session by id, or undefined when this runtime has none: the local
 * runtime returns undefined, the service answers SESSION_NOT_FOUND. */
async function findSession(runtime: TuiRuntime, id: string) {
  try {
    return await runtime.getSession(id);
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 'SESSION_NOT_FOUND') { return undefined; }
    throw error;
  }
}
