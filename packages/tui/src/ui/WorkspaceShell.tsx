import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { createApiClient, startupWorkspaces, type ApiClientOptions } from '@marifold/client';
import { MarifoldRuntime } from '@marifold/core';
import type { WorkspaceSummary, WorkspaceDevice, LoadedMarifoldConfig } from '@marifold/core';
import { RemoteRuntime } from '../core/RemoteRuntime.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { App, type AppProps } from './App.js';

interface Props {
  local: MarifoldRuntime;
  loadedConfig: LoadedMarifoldConfig;
  service: ApiClientOptions;
  profile?: string;
  resume?: string | boolean;
  version: string;
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
  const [notice, setNotice] = useState('Connecting to workspace…');
  const selected = useRef<string>('local');
  const execution = useRef<string | undefined>(undefined);
  const localApi = useRef(createApiClient(props.service)).current;
  const serial = useRef(0);
  const load = useCallback(
    async (id: string, resume?: string | boolean): Promise<void> => {
      const version = ++serial.current;
      let runtime: TuiRuntime = props.local;
      let config = props.loadedConfig;
      let name = 'Local';
      if (id !== 'local') {
        const result = await localApi.request<{ workspaces: WorkspaceSummary[] }>('GET', '/v1/workspaces');
        const candidates = result.workspaces.filter((w) => w.id === id || w.name === id);
        if (candidates.length !== 1)
          throw new Error(candidates.length ? 'Workspace name is ambiguous; use its ID.' : 'Workspace not found.');
        const workspace = candidates[0]!;
        if (!workspace.online) throw new Error('Workspace host is offline.');
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
      let settings;
      try {
        settings = runtime.resolveSettings({ profile: props.profile });
      } catch {
        if (id !== 'local') throw new Error('Choose a profile with a configured model on this workspace.');
        settings = { profile: config.config.default.profile, provider: '', model: '(configure a model)', think: false };
      }
      let sessionId: string | undefined;
      if (typeof resume === 'string') sessionId = resume;
      else if (resume === true)
        sessionId = (await runtime.listSessions(1, settings.profile, { order: 'recent' }))[0]?.id;
      const session = sessionId ? await runtime.getSession(sessionId) : undefined;
      if (version !== serial.current) return;
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
          transcript: session?.turns.map((t) => ({ kind: t.role, text: t.content })),
        },
      });
      setNotice(`${name} workspace · /workspace list · /device list`);
    },
    [localApi, props.local, props.loadedConfig, props.profile, props.service, props.version],
  );
  useEffect(() => {
    let alive = true;
    void startupWorkspaces<WorkspaceSummary>(localApi)
      .then(async (result) => {
        if (!alive) return;
        const workspace = result.workspaces.find((w) => w.id === result.defaultId && w.online);
        await load(workspace?.id ?? 'local', props.resume);
        if (result.defaultId !== 'local' && !workspace)
          setNotice('Default workspace is offline. Opened Local for this launch.');
      })
      .catch(async () => {
        if (alive) {
          await load('local', props.resume);
          setNotice('Workspace service unavailable. Opened Local.');
        }
      });
    return () => {
      alive = false;
      serial.current++;
    };
  }, []);
  useEffect(() => {
    if (!(entry?.runtime instanceof RemoteRuntime)) return;
    const remote = entry.runtime;
    let busy = false;
    let alive = true;
    let revision: string | undefined;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void remote.api
        .request<{ revision: string }>('GET', '/v1/changes')
        .then(async (result) => {
          if (revision !== result.revision) {
            await remote.refresh();
            revision = result.revision;
            if (alive)
              setEntry((current) =>
                current?.runtime === remote ? { ...current, config: remote.loadedConfig } : current,
              );
          }
        })
        .catch(() => {
          if (alive) setNotice(`${entry.name} is unavailable. This conversation stays in its workspace.`);
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
    if (selected.current === 'local')
      return 'Local tools run on this device. Join a workspace to select another device.';
    const { devices } = await localApi.request<{ devices: WorkspaceDevice[] }>(
      'POST',
      `/v1/workspaces/${selected.current}/manage/devices`,
      {},
    );
    const [operation, value] = args.trim().split(/\s+/);
    if (operation === 'use' && value) {
      if (!['auto', 'host'].includes(value) && !devices.some((d) => d.id === value && d.online && d.executor))
        throw new Error('Device is unavailable or has not enabled execution.');
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
      <Text dimColor>{notice}</Text>
      {entry && (
        <App
          key={entry.key}
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
