import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from '../api/client';
import type { WorkspaceSummary, WorkspaceDevice } from '../api/types';
import { apiSettings, THIS_SERVER_ID, type ServerConnection } from '../state/connection';
import { ConnectionPopover, type ConnectionPopoverProps } from './ConnectionPopover';
import styles from './ConnectionPopover.module.css';

interface Props extends ConnectionPopoverProps {
  executionDevice?: string;
  onExecutionDevice: (id?: string) => void;
}
export function WorkspacePopover(props: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const [editorOverflows, setEditorOverflows] = useState(false);
  const local = props.store.servers.find((c) => c.id === THIS_SERVER_ID)!;
  const api = useMemo(() => createApiClient(apiSettings(local)), [local.token]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [defaultId, setDefaultId] = useState('local');
  const active = props.store.servers.find((c) => c.id === props.store.activeId);
  const [selected, setSelected] = useState(active?.workspaceId ?? 'local');
  const [mode, setMode] = useState<'select' | 'create' | 'join' | 'direct'>('select');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [executor, setExecutor] = useState(false);
  const [invitation, setInvitation] = useState('');
  const [devices, setDevices] = useState<Array<WorkspaceDevice & { host: boolean }>>([]);
  const sortedDevices = useMemo(() => [...devices].sort((a, b) => {
    if (a.host !== b.host) return a.host ? -1 : 1;
    const aJoined = Number.isFinite(a.joinedAt) ? a.joinedAt! : Infinity;
    const bJoined = Number.isFinite(b.joinedAt) ? b.joinedAt! : Infinity;
    if (aJoined !== bJoined) return aJoined < bJoined ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  }), [devices]);
  const [error, setError] = useState(props.problem);
  const [busy, setBusy] = useState(false);
  const [deviceChoice, setDeviceChoice] = useState(props.executionDevice);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const workspace = workspaces.find((w) => w.id === selected);
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    const measure = () => setEditorOverflows(node.scrollHeight > node.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // Both viewport changes and asynchronously loaded content affect overflow.
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  });
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => previous?.focus();
  }, []);
  async function refresh() {
    const result = await api.request<{ workspaces: WorkspaceSummary[]; defaultId: string }>('GET', '/v1/workspaces');
    setWorkspaces(result.workspaces);
    setDefaultId(result.defaultId);
  }
  useEffect(() => {
    let active = true;
    const update = () =>
      refresh().catch((e) => {
        if (active) setError(String(e.message));
      });
    void update();
    const timer = setInterval(() => {
      void update();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    setDevices([]);
    setName(workspace?.name ?? '');
    setConfirmRemove(false);
    if (!workspace?.online) return;
    let stopped = false;
    const update = () =>
      api
        .request<{ devices: Array<WorkspaceDevice & { host: boolean }> }>(
          'POST',
          `/v1/workspaces/${workspace.id}/manage/devices`,
          {},
        )
        .then((r) => {
          if (!stopped) setDevices(r.devices);
        })
        .catch(() => undefined);
    void update();
    const timer = setInterval(() => {
      void update();
    }, 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workspace?.id, workspace?.online, api]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) props.onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, props.onClose]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function manage(operation: string, body: unknown = {}) {
    return api.request<{ invitation?: string }>('POST', `/v1/workspaces/${selected}/manage/${operation}`, body);
  }
  async function connect() {
    const connection: ServerConnection = workspace
      ? { id: `workspace-${workspace.id}`, name: workspace.name, workspaceId: workspace.id, token: local.token }
      : local;
    const problem = await props.onConnect(connection);
    if (problem) throw new Error(problem);
    props.onExecutionDevice(deviceChoice);
    props.onClose();
  }
  if (mode === 'direct')
    return (
      <ConnectionPopover
        {...props}
        store={{ ...props.store, servers: props.store.servers.filter((c) => !c.workspaceId) }}
        onClose={props.onClose}
      />
    );
  return (
    <div className={styles.backdrop} onClick={busy ? undefined : props.onClose}>
      <div
        ref={dialog}
        className={styles.popover}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
            ) ?? [],
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.titleRow}>
          <div>
            <div id="workspace-title" className={styles.title}>
              Workspace
            </div>
            <div className={styles.subtitle}>Your profiles and sessions, across your devices.</div>
          </div>
          <button className={styles.cancel} onClick={props.onClose} disabled={busy}>
            Close
          </button>
        </div>
        {error && (
          <div className={styles.problem} role="alert">
            {error}
          </div>
        )}
        {mode === 'select' ? (
          <>
            <div className={styles.body}>
              <div className={styles.serverList} aria-label="Workspaces">
                <button
                  aria-pressed={selected === 'local'}
                  className={selected === 'local' ? styles.serverSelected : styles.server}
                  onClick={() => {
                    setSelected('local');
                    setDeviceChoice(undefined);
                  }}
                >
                  <span>Local</span>
                  <span className={styles.serverUrl}>This device · always available</span>
                </button>
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    aria-pressed={selected === w.id}
                    className={selected === w.id ? styles.serverSelected : styles.server}
                    onClick={() => {
                      setSelected(w.id);
                      setDeviceChoice(undefined);
                    }}
                  >
                    <span>{w.name}</span>
                    <span className={styles.serverUrl}>
                      {w.role === 'host' ? 'Hosted here' : 'Paired'} · {w.online ? 'Online' : 'Offline'}
                    </span>
                  </button>
                ))}
              </div>
              <div ref={editor} className={`${styles.editor} ${editorOverflows ? styles.scrollingEditor : ''}`}>
                {workspace ? (
                  <>
                    <label className={styles.field}>
                      Workspace name
                      <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={busy} />
                    </label>
                    <button
                      className={styles.add}
                      disabled={busy || !workspace.online || name === workspace.name}
                      onClick={() =>
                        void perform(async () => {
                          await manage('rename', { name });
                          await refresh();
                        })
                      }
                    >
                      Rename
                    </button>
                    <label className={styles.field}>
                      Tools for the next conversation
                      <select
                        value={deviceChoice ?? 'auto'}
                        onChange={(e) => setDeviceChoice(e.target.value === 'auto' ? undefined : e.target.value)}
                      >
                        <option value="auto">Automatic · this device if enabled</option>
                        <option value="host">Workspace host</option>
                        {sortedDevices
                          .filter((d) => !d.host)
                          .map((d) => (
                            <option key={d.id} value={d.id} disabled={!d.online || !d.executor}>
                              {d.name} · {d.online ? (d.executor ? 'Ready' : 'Viewing only') : 'Offline'}
                            </option>
                          ))}
                      </select>
                    </label>
                    <span className={styles.hint}>
                      Skills and Apps run on the host. Approve each remote tool call here before it runs on the selected
                      device.
                    </span>
                    <section aria-labelledby="workspace-devices-title">
                      <h3 id="workspace-devices-title" className={styles.deviceHeading}>Devices</h3>
                      <div className={styles.deviceList} role="list">
                        {sortedDevices.map((d) => (
                          <div role="listitem" key={d.id} className={`${styles.deviceRow} ${d.host ? styles.hostRow : ''}`}>
                            <span className={`${styles.hint} ${d.online ? styles.deviceOnline : ''}`}>
                              {d.host ? <strong className={styles.hostName}>{d.name}</strong> : d.name}{' '}
                              {d.host ? '(host)' : d.id === workspace.deviceId ? '(this device)' : ''} · {d.online ? 'online' : 'offline'}
                            </span>
                            {!d.host && (
                              <button
                                className={styles.remove}
                                disabled={busy}
                                onClick={() =>
                                  void perform(async () => {
                                    await manage('revoke', { deviceId: d.id });
                                    setDevices((ds) => ds.filter((item) => item.id !== d.id));
                                  })
                                }
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                    {workspace.role === 'guest' && (
                      <label className={styles.hint}>
                        <input
                          type="checkbox"
                          checked={workspace.executor === true}
                          disabled={busy}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            setWorkspaces((items) =>
                              items.map((item) => (item.id === workspace.id ? { ...item, executor: enabled } : item)),
                            );
                            void perform(async () => {
                              try {
                                await api.request('PUT', `/v1/workspaces/${workspace.id}/executor`, { enabled });
                                await refresh();
                              } catch (error) {
                                setWorkspaces((items) =>
                                  items.map((item) =>
                                    item.id === workspace.id ? { ...item, executor: !enabled } : item,
                                  ),
                                );
                                throw error;
                              }
                            });
                          }}
                        />{' '}
                        Allow agent tools on this device
                      </label>
                    )}
                    <button
                      className={styles.add}
                      disabled={busy || !workspace.online}
                      onClick={() =>
                        void perform(async () => {
                          const result = await manage('invite');
                          setInvitation(result.invitation ?? '');
                        })
                      }
                    >
                      New invitation
                    </button>
                    <button
                      className={styles.remove}
                      disabled={busy}
                      onClick={() => {
                        if (!confirmRemove) {
                          setConfirmRemove(true);
                          return;
                        }
                        void perform(async () => {
                          await api.request('DELETE', `/v1/workspaces/${selected}`);
                          props.onRemove(`workspace-${selected}`);
                          setSelected('local');
                          await refresh();
                        });
                      }}
                    >
                      {confirmRemove
                        ? 'Confirm disconnect'
                        : workspace.role === 'host'
                          ? 'Stop sharing this workspace'
                          : 'Disconnect workspace'}
                    </button>
                  </>
                ) : (
                  <div className={styles.sameOriginNote}>
                    Local uses this device’s profiles and sessions. It is also the fallback when your default workspace
                    is unavailable at startup.
                  </div>
                )}
                <button
                  className={styles.add}
                  disabled={busy || defaultId === selected}
                  onClick={() =>
                    void perform(async () => {
                      await api.request('PUT', '/v1/workspaces/default', { id: selected });
                      setDefaultId(selected);
                    })
                  }
                >
                  {defaultId === selected ? 'Startup default' : 'Use at startup'}
                </button>
              </div>
            </div>
            <div className={styles.actions}>
              <button
                className={styles.add}
                onClick={() => {
                  setMode('create');
                  setName('');
                }}
              >
                Host this device
              </button>
              <button className={styles.add} onClick={() => setMode('join')}>
                Join workspace
              </button>
              <button className={styles.cancel} onClick={() => setMode('direct')}>
                Direct servers
              </button>
              <button
                className={styles.connect}
                disabled={busy || Boolean(workspace && !workspace.online)}
                onClick={() => void perform(connect)}
              >
                Open
              </button>
            </div>
          </>
        ) : (
          <form
            className={styles.editor}
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                if (mode === 'create') {
                  const result = await api.request<{ invitation: string; workspace: WorkspaceSummary }>(
                    'POST',
                    '/v1/workspaces',
                    { name, bridgeUrl: url, registrationToken: secret },
                  );
                  setInvitation(result.invitation);
                  setSelected(result.workspace.id);
                } else {
                  const result = await api.request<{ workspace: WorkspaceSummary }>('POST', '/v1/workspaces/join', {
                    bridgeUrl: url,
                    invitation: secret,
                    executor,
                  });
                  setSelected(result.workspace.id);
                }
                setSecret('');
                await refresh();
                setMode('select');
              });
            }}
          >
            <div className={styles.sameOriginNote}>
              {mode === 'create'
                ? 'Share this device’s existing profiles and sessions. Keep its service running so paired devices can connect. Use a deployed Marifold bridge; deploy the bridge package on Vercel with Redis, then enter its URL and registration token.'
                : 'Join your workspace with a single-use invitation from its host.'}
            </div>
            {mode === 'create' && (
              <label className={styles.field}>
                Workspace name
                <input required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label className={styles.field}>
              Bridge URL
              <input
                type="url"
                required
                value={url}
                placeholder="https://your-bridge.vercel.app"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              {mode === 'create' ? 'Bridge registration token' : 'Invitation'}
              <input
                type="password"
                required
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            {mode === 'join' && (
              <label className={styles.hint}>
                <input type="checkbox" checked={executor} onChange={(e) => setExecutor(e.target.checked)} /> Enable
                approval-gated agent tools on this device
              </label>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                className={styles.cancel}
                onClick={() => {
                  setMode('select');
                  setSecret('');
                }}
              >
                Back
              </button>
              <button className={styles.connect} disabled={busy}>
                {busy ? 'Connecting…' : mode === 'create' ? 'Host workspace' : 'Join'}
              </button>
            </div>
          </form>
        )}
        {invitation && (
          <label className={styles.field}>
            Single-use invitation · expires in 15 minutes
            <textarea readOnly value={invitation} rows={3} onFocus={(e) => e.target.select()} />
          </label>
        )}
      </div>
    </div>
  );
}
