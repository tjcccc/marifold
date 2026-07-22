import { useEffect, useState } from 'react';
import type { ConnectionSettings } from '../state/connection';
import styles from './ConnectionPopover.module.css';

export interface ConnectionPopoverProps {
  settings: ConnectionSettings;
  /** Non-empty when the last request failed auth — shown inline. */
  problem?: string;
  onSave: (settings: ConnectionSettings) => void;
  onClose: () => void;
}

/** Small settings sheet for the service connection (dev base URL + bearer
 * token). Opened from the primary sidebar; values persist to localStorage. */
export function ConnectionPopover({ settings, problem, onSave, onClose }: ConnectionPopoverProps) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
  const [token, setToken] = useState(settings.token ?? '');

  function save(): void {
    onSave({
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim().replace(/\/$/, '') } : {}),
      ...(token.trim() ? { token: token.trim() } : {}),
    });
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <form
        className={styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
        onSubmit={event => {
          event.preventDefault();
          save();
        }}
        onClick={event => event.stopPropagation()}
      >
        <div id="connection-title" className={styles.title}>Connection</div>
        <div className={styles.subtitle}>Connect to a local or securely forwarded Marifold service.</div>
        {problem ? <div className={styles.problem}>{problem}</div> : null}
        <label className={styles.field}>
          <span>Service URL</span>
          <input
            type="text"
            value={baseUrl}
            placeholder="same origin"
            onChange={event => setBaseUrl(event.target.value)}
          />
        </label>
        <div className={styles.field}>
          <label htmlFor="connection-token">Bearer token</label>
          <input
            id="connection-token"
            type="password"
            value={token}
            placeholder="none"
            autoComplete="off"
            aria-describedby="connection-token-hint"
            onChange={event => setToken(event.target.value)}
          />
          <span id="connection-token-hint" className={styles.hint}>
            Must match the optional token configured on the service host.
          </span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.save}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
