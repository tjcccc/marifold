import { useState } from 'react';
import styles from './SessionBlockedBanner.module.css';

export interface SessionBlockedBannerProps {
  onTakeOver: () => Promise<void>;
}

/** Shown under the "in use elsewhere" notice. A workspace belongs to one
 * person, so they can move the session here from their other device; a task
 * running there keeps going and appears here. */
export function SessionBlockedBanner({ onTakeOver }: SessionBlockedBannerProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>This session is open on another page or device.</span>
      <button
        className={styles.action}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onTakeOver().finally(() => setBusy(false));
        }}
      >
        {busy ? 'Opening…' : 'Open here'}
      </button>
    </div>
  );
}

export interface SessionArchivedBannerProps {
  onUnarchive: () => Promise<unknown>;
}

/** Shown in place of sending for an archived session: it can be read, and
 * continues once unarchived. */
export function SessionArchivedBanner({ onUnarchive }: SessionArchivedBannerProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>This session has been archived. Unarchive it to continue.</span>
      <button
        className={styles.action}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onUnarchive().finally(() => setBusy(false));
        }}
      >
        {busy ? 'Unarchiving…' : 'Unarchive'}
      </button>
    </div>
  );
}
