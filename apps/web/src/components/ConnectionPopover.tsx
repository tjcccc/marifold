import { useEffect, useState } from 'react';
import type { ConnectionStore, ServerConnection } from '../state/connection';
import {
  newConnectionId,
  normalizeServerName,
  normalizeServerUrl,
  THIS_SERVER_ID,
} from '../state/connection';
import styles from './ConnectionPopover.module.css';

export interface ConnectionPopoverProps {
  store: ConnectionStore;
  /** Non-empty when the active server rejected the current credentials. */
  problem?: string;
  onConnect: (connection: ServerConnection) => Promise<string | undefined>;
  onRemove: (id: string) => void;
  onClose: () => void;
}

/** Named Marifold server selector. "This server" uses the page's origin;
 * remote entries carry an explicit API root and independently saved token. */
export function ConnectionPopover({ store, problem, onConnect, onRemove, onClose }: ConnectionPopoverProps) {
  const initial = store.servers.find(server => server.id === store.activeId) ?? store.servers[0]!;
  const [selectedId, setSelectedId] = useState(initial.id);
  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [token, setToken] = useState(initial.token ?? '');
  const [localProblem, setLocalProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const thisServer = selectedId === THIS_SERVER_ID;
  const savedSelection = store.servers.some(server => server.id === selectedId);
  const visibleProblem = localProblem ?? (selectedId === store.activeId ? problem : undefined);

  function select(connection: ServerConnection): void {
    setSelectedId(connection.id);
    setName(connection.name);
    setBaseUrl(connection.baseUrl ?? '');
    setToken(connection.token ?? '');
    setLocalProblem(undefined);
  }

  function addServer(): void {
    setSelectedId(newConnectionId());
    setName('');
    setBaseUrl('');
    setToken('');
    setLocalProblem(undefined);
  }

  async function connect(): Promise<void> {
    if (busy) return;
    let candidate: ServerConnection;
    try {
      candidate = thisServer
        ? {
            id: THIS_SERVER_ID,
            name: 'This server',
            ...(token.trim() ? { token: token.trim() } : {}),
          }
        : {
            id: selectedId,
            name: normalizeServerName(name),
            baseUrl: normalizeServerUrl(baseUrl),
            ...(token.trim() ? { token: token.trim() } : {}),
          };
    } catch (error) {
      setLocalProblem(error instanceof Error ? error.message : String(error));
      return;
    }

    setBusy(true);
    setLocalProblem(undefined);
    const connectionProblem = await onConnect(candidate);
    setBusy(false);
    if (connectionProblem) {
      setLocalProblem(connectionProblem);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div className={styles.backdrop} onClick={busy ? undefined : onClose}>
      <form
        className={styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
        onSubmit={event => {
          event.preventDefault();
          void connect();
        }}
        onClick={event => event.stopPropagation()}
      >
        <div className={styles.titleRow}>
          <div>
            <div id="connection-title" className={styles.title}>Connection</div>
            <div className={styles.subtitle}>Choose the Marifold server that owns this workspace.</div>
          </div>
          <button type="button" className={styles.add} onClick={addServer} disabled={busy}>Add server</button>
        </div>

        <div className={styles.body}>
          <div className={styles.serverList} aria-label="Saved servers">
            {store.servers.map(server => (
              <button
                key={server.id}
                type="button"
                className={selectedId === server.id ? styles.serverSelected : styles.server}
                aria-pressed={selectedId === server.id}
                onClick={() => select(server)}
                disabled={busy}
              >
                <span className={styles.serverName}>{server.name}</span>
                <span className={styles.serverUrl}>{server.baseUrl ?? window.location.origin}</span>
                {store.activeId === server.id ? <span className={styles.activeBadge}>Active</span> : null}
              </button>
            ))}
          </div>

          <div className={styles.editor}>
            {visibleProblem ? <div className={styles.problem}>{visibleProblem}</div> : null}
            {thisServer ? (
              <div className={styles.sameOriginNote}>
                Uses the server that delivered this page: <strong>{window.location.origin}</strong>
              </div>
            ) : (
              <>
                <label className={styles.field}>
                  <span>Server name</span>
                  <input
                    type="text"
                    value={name}
                    placeholder="Mac mini"
                    maxLength={80}
                    disabled={busy}
                    onChange={event => setName(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>Service URL</span>
                  <input
                    type="url"
                    value={baseUrl}
                    placeholder="http://100.x.y.z:32140"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                    onChange={event => setBaseUrl(event.target.value)}
                  />
                </label>
              </>
            )}
            <div className={styles.field}>
              <label htmlFor="connection-token">Bearer token</label>
              <input
                id="connection-token"
                type="password"
                value={token}
                placeholder="none"
                autoComplete="off"
                disabled={busy}
                aria-describedby="connection-token-hint"
                onChange={event => setToken(event.target.value)}
              />
              <span id="connection-token-hint" className={styles.hint}>
                Saved separately for this server and sent only in API authorization headers.
              </span>
            </div>
            {!thisServer && savedSelection ? (
              <button
                type="button"
                className={styles.remove}
                disabled={busy}
                onClick={() => {
                  onRemove(selectedId);
                  const fallback = store.servers.find(server => server.id === THIS_SERVER_ID)!;
                  select(fallback);
                }}
              >
                Remove server
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.connect} disabled={busy}>
            {busy ? 'Checking…' : store.activeId === selectedId ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}
