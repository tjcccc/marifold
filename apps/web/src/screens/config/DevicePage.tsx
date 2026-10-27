import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { getDeviceExecution, turnOffFullAccess, type DeviceExecutionView } from '../../api/misc';
import { CopyButton } from '../../components/CopyButton';
import styles from './SystemPages.module.css';

const ENABLE_COMMAND = 'marifold execution mode full';

export interface DevicePageProps {
  /** The service serving this page, never a workspace host: the setting is this device's own. */
  client: ApiClient;
}

/** Full access on the device serving the page. It shows the mode and turns it
 * off; turning it on stays a local command (docs/device-execution.md). */
export function DevicePage({ client }: DevicePageProps) {
  const [view, setView] = useState<DeviceExecutionView>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await getDeviceExecution(client));
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function turnOff(): Promise<void> {
    setBusy(true);
    try {
      setView(await turnOffFullAccess(client));
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const full = view?.mode === 'full';
  const device = view?.device ?? 'this device';

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>This device</div>
          <div className={styles.pageSub}>
            {view ? `${view.device} · ` : ''}Settings that stay on this device. Other workspace devices never see or change them.
          </div>
        </div>
      </header>

      {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}

      <section className={styles.card} aria-label="Full access">
        <div className={styles.cardTitle}>Full access</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Status</span>
          {full ? (
            <div className={styles.fieldEdit}>
              <span className={styles.fieldStatic}>On</span>
              <button className={styles.saveAction} disabled={busy} onClick={() => void turnOff()}>
                {busy ? 'Turning off…' : 'Turn off'}
              </button>
            </div>
          ) : (
            <span className={styles.fieldStatic}>{view ? 'Off' : 'Checking…'}</span>
          )}
        </div>
        {view && !full ? (
          <div className={styles.fieldRow}>
            <span className={styles.optionName}>{ENABLE_COMMAND}</span>
            <CopyButton text={ENABLE_COMMAND} label="Copy" variant="text" className={styles.saveAction} />
          </div>
        ) : null}
        <div className={styles.cardNote}>
          {full
            ? `Profiles may ask to run a command on ${device} as your account, with its files, network and apps, for example to control Keynote. You approve each command. Turning it off stops new full-access commands; ones already running finish.`
            : `Profiles run commands in a sandbox: no network, no control of other apps, and writes only to their own folders. Full access lets them ask to run a command as your account, and you approve each one. To turn it on, run the command above in Terminal on ${device}. It cannot be turned on from a browser, so nothing that reaches this page can grant itself that access.`}
        </div>
      </section>
    </div>
  );
}
