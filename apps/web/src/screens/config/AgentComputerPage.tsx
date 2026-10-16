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
  creating: 'Creating… (the first build can take ten minutes or more)',
  failed: 'Failed',
};

/** `managedHere` is false on another device of the host's workspace. */
type ComputerPageStatus = AgentComputerStatus & { managedHere?: boolean };

/** The agent's own Linux computer, on the device that hosts the profiles.
 * Other workspace devices see it and give or remove profile access only. */
export function AgentComputerPage({ client }: AgentComputerPageProps) {
  const [status, setStatus] = useState<ComputerPageStatus>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [proxy, setProxy] = useState<string>();
  const [baseImage, setBaseImage] = useState<string>();
  /** 'computer' or a profile name whose Remove is waiting for a second click. */
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.request<ComputerPageStatus>('GET', '/v1/agent-computer'));
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);
  const creating = status?.computer.state === 'creating';
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
  const computer = status?.computer;
  const exists = computer?.state === 'running' || computer?.state === 'stopped';
  const managedHere = status?.managedHere !== false;
  const setAccess = (profile: string, access: boolean) => act(() => client.request('PUT', `/v1/agent-computer/profiles/${encodeURIComponent(profile)}`, { access }));

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Agent computer</div>
          <div className={styles.pageSub}>
            A Linux computer the agent uses without approval prompts, with sudo. Each profile you give access gets its
            own account there. It runs in Docker on {managedHere ? 'this device' : 'the workspace host'}, cannot reach your
            devices or local network, and receives your files only when the agent copies them in with your approval.
          </div>
        </div>
      </header>

      {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}
      {managedHere ? null : (
        <div className={styles.cardNote}>
          This computer belongs to the workspace host. From this device you can give or remove a profile's access; create,
          rebuild, or remove it and change its settings on the host.
        </div>
      )}

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
          {managedHere ? <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={proxyValue}
              placeholder="http://127.0.0.1:7890"
              onChange={event => setProxy(event.target.value)}
            />
            {proxy !== undefined && proxy !== (status?.settings.proxy ?? '') ? (
              <button className={styles.saveAction} disabled={busy} onClick={() => void saveSettings({ proxy: proxy.trim() })}>Save</button>
            ) : null}
          </div> : <span className={styles.fieldStatic}>{proxyValue || 'None'}</span>}
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Base image</span>
          {managedHere ? <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={baseImageValue}
              placeholder="Default: ubuntu:24.04"
              onChange={event => setBaseImage(event.target.value)}
            />
            {baseImage !== undefined && baseImage !== (status?.settings.baseImage ?? '') ? (
              <button className={styles.saveAction} disabled={busy} onClick={() => void saveSettings({ baseImage: baseImage.trim() })}>Save</button>
            ) : null}
          </div> : <span className={styles.fieldStatic}>{baseImageValue || 'Default: ubuntu:24.04'}</span>}
        </div>
        <div className={styles.cardNote}>
          {status?.settings.upstream
            ? `The computer reaches the proxy as ${status.settings.upstream}. Local and private addresses stay blocked. Docker itself downloads the base image through its own network settings.`
            : 'No proxy: the computer connects to the internet directly. Local and private addresses are always blocked. Docker itself downloads the base image through its own network settings.'}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Computer</div>
        <div className={styles.optionRow}>
          <span className={styles.optionMeta}>{computer ? STATE_LABEL[computer.state] ?? computer.state : 'Checking…'}</span>
          <span className={styles.pageActions}>
            {managedHere && (computer?.state === 'missing' || computer?.state === 'failed') ? (
              <button
                className={styles.saveAction}
                disabled={busy || !docker?.available}
                onClick={() => void act(() => client.request('POST', '/v1/agent-computer/computer', {}))}
              >
                Create agent computer
              </button>
            ) : null}
            {managedHere && exists ? (
              <>
                <button
                  className={styles.linkAction}
                  disabled={busy}
                  title="Rebuild the image and recreate the computer. Files in home folders are kept; installed software is not."
                  onClick={() => void act(() => client.request('POST', '/v1/agent-computer/computer', { rebuildImage: true }))}
                >
                  Rebuild
                </button>
                {confirmRemove === 'computer' ? (
                  <button
                    className={styles.removeAction}
                    disabled={busy}
                    onClick={() => void act(async () => {
                      await client.request('DELETE', '/v1/agent-computer/computer');
                      setConfirmRemove(undefined);
                    })}
                  >
                    Remove with all accounts and files
                  </button>
                ) : (
                  <button className={styles.removeAction} disabled={busy} onClick={() => setConfirmRemove('computer')}>Remove</button>
                )}
              </>
            ) : null}
          </span>
        </div>
        {computer?.error ? (
          <div className={styles.errorBox} role="alert">
            {computer.error}
            {computer.errorDetail ? (
              <details>
                <summary>Details</summary>
                <pre className={styles.errorDetail}>{computer.errorDetail}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
        <div className={styles.cardNote}>
          Rebuild keeps every account's home folder; software installed outside them (for example with apt) is lost.
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Profiles</div>
        {(status?.profiles ?? []).map(item => (
          <div key={item.profile} className={styles.optionRow}>
            <span className={styles.optionName}>
              {item.profile}
              <span className={styles.optionMeta}>
                {item.fixed
                  ? ` · the agent itself, account ${item.accountName}${item.account ? '' : ' (created with the computer)'}`
                  : ` · ${item.access ? `Has access as ${item.accountName}` : item.account ? 'Account, no access' : 'No access'}`}
              </span>
              {item.problem ? <span className={styles.optionMeta}> — {item.problem}</span> : null}
            </span>
            <span className={styles.pageActions}>
              {item.fixed ? null : item.access ? (
                <button className={styles.linkAction} disabled={busy} onClick={() => void setAccess(item.profile, false)}>Remove access</button>
              ) : (
                <button
                  className={styles.saveAction}
                  disabled={busy || computer?.state !== 'running' || Boolean(item.problem)}
                  title={item.account ? 'Use the existing account and its files.' : `Create the account ${item.profile} with the home folder /home/${item.profile}.`}
                  onClick={() => void setAccess(item.profile, true)}
                >
                  Give access
                </button>
              )}
              {managedHere && !item.fixed && item.account && !item.access ? (
                confirmRemove === item.profile ? (
                  <button
                    className={styles.removeAction}
                    disabled={busy}
                    onClick={() => void act(async () => {
                      await client.request('DELETE', `/v1/agent-computer/profiles/${encodeURIComponent(item.profile)}`);
                      setConfirmRemove(undefined);
                    })}
                  >
                    Delete account and files
                  </button>
                ) : (
                  <button className={styles.removeAction} disabled={busy} onClick={() => setConfirmRemove(item.profile)}>Remove account</button>
                )
              ) : null}
            </span>
          </div>
        ))}
        <div className={styles.cardNote}>
          The default profile is the agent itself and always uses the marifold account. Each other profile with access
          works in its own account (with sudo) and home folder. It uses the computer through
          computer_exec, computer_write_file, computer_put (copies a file or folder from this device, with your approval)
          and computer_get (brings a file back as a run result). Credentials and marifold state are never copied in.
          Remove access keeps the account and its files; the row then offers Remove account to delete them
          {managedHere ? '' : ' (on the workspace host)'}. Deleting a profile also deletes its account.
        </div>
      </section>
    </div>
  );
}
