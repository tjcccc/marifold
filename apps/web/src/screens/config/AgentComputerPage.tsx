import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { AgentComputerStatus } from '../../api/types';
import styles from './SystemPages.module.css';

export interface AgentComputerPageProps {
  client: ApiClient;
}

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  missing: 'Not created',
  creating: 'Creating… (the first build takes a few minutes)',
  failed: 'Failed',
};

/** The agent's own Linux computers. Device-local: never reached through a workspace. */
export function AgentComputerPage({ client }: AgentComputerPageProps) {
  const [status, setStatus] = useState<AgentComputerStatus>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [proxy, setProxy] = useState<string>();
  const [baseImage, setBaseImage] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.request<AgentComputerStatus>('GET', '/v1/agent-computer'));
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);
  const creating = status?.computers.some(computer => computer.state === 'creating') === true;
  useEffect(() => {
    if (!creating) { return undefined; }
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [creating, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const saveSettings = (next: { proxy?: string; baseImage?: string }) => act(async () => {
    await client.request('PUT', '/v1/agent-computer/settings', {
      proxy: next.proxy ?? status?.settings.proxy ?? '',
      baseImage: next.baseImage ?? status?.settings.baseImage ?? '',
    });
    setProxy(undefined);
    setBaseImage(undefined);
  });

  const proxyValue = proxy ?? status?.settings.proxy ?? '';
  const baseImageValue = baseImage ?? status?.settings.baseImage ?? '';
  const docker = status?.docker;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Agent computer</div>
          <div className={styles.pageSub}>
            A Linux computer for each profile that the agent uses without approval prompts, with sudo. It runs in Docker on
            this device, cannot reach your devices or local network, and receives your files only when the agent copies
            them in with your approval.
          </div>
        </div>
      </header>

      {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}

      <section className={styles.card}>
        <div className={styles.cardTitle}>Docker</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Status</span>
          <span className={styles.fieldStatic}>
            {!docker ? 'Checking…' : docker.available
              ? `${docker.runtime} · Docker ${docker.serverVersion} · ${docker.platform}`
              : docker.error}
          </span>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Network</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Proxy</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={proxyValue}
              placeholder="http://127.0.0.1:7890"
              onChange={event => setProxy(event.target.value)}
            />
            {proxy !== undefined && proxy !== (status?.settings.proxy ?? '') ? (
              <button className={styles.saveAction} disabled={busy} onClick={() => void saveSettings({ proxy: proxy.trim() })}>Save</button>
            ) : null}
          </div>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel} />
          <span className={styles.fieldHint}>
            {status?.settings.upstream
              ? `The computers reach it as ${status.settings.upstream}. Local and private addresses stay blocked.`
              : 'Empty: the computers connect to the internet directly. Local and private addresses are always blocked.'}
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Base image</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={baseImageValue}
              placeholder="ubuntu:24.04"
              onChange={event => setBaseImage(event.target.value)}
            />
            {baseImage !== undefined && baseImage !== (status?.settings.baseImage ?? '') ? (
              <button className={styles.saveAction} disabled={busy} onClick={() => void saveSettings({ baseImage: baseImage.trim() })}>Save</button>
            ) : null}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Computers</div>
        {(status?.computers ?? []).map(computer => (
          <div key={computer.profile} className={styles.optionRow}>
            <span className={styles.optionName}>
              {computer.profile}
              <span className={styles.fieldHint}> · {STATE_LABEL[computer.state] ?? computer.state}</span>
              {computer.error ? <span className={styles.fieldHint}> — {computer.error}</span> : null}
            </span>
            <span className={styles.pageActions}>
              {computer.state === 'missing' || computer.state === 'failed' ? (
                <button
                  className={styles.saveAction}
                  disabled={busy || !docker?.available}
                  onClick={() => void act(() => client.request('POST', `/v1/agent-computer/computers/${encodeURIComponent(computer.profile)}`, {}))}
                >
                  Create
                </button>
              ) : null}
              {computer.state === 'running' || computer.state === 'stopped' ? (
                <>
                  <button
                    className={styles.linkAction}
                    disabled={busy}
                    title="Rebuild the image and recreate this computer. Its files are lost."
                    onClick={() => void act(() => client.request('POST', `/v1/agent-computer/computers/${encodeURIComponent(computer.profile)}`, { rebuildImage: true }))}
                  >
                    Rebuild
                  </button>
                  {confirmRemove === computer.profile ? (
                    <button
                      className={styles.removeAction}
                      disabled={busy}
                      onClick={() => void act(async () => {
                        await client.request('DELETE', `/v1/agent-computer/computers/${encodeURIComponent(computer.profile)}`);
                        setConfirmRemove(undefined);
                      })}
                    >
                      Remove and delete its files
                    </button>
                  ) : (
                    <button className={styles.removeAction} disabled={busy} onClick={() => setConfirmRemove(computer.profile)}>Remove</button>
                  )}
                </>
              ) : null}
            </span>
          </div>
        ))}
        <div className={styles.note}>
          The agent uses its computer through computer_exec, computer_write_file, computer_put (copies a file or folder
          from this device, with your approval) and computer_get (brings a file back as a run result). Credentials and
          Marifold state are never copied in.
        </div>
      </section>
    </div>
  );
}
