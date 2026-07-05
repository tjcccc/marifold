import { useState } from 'react';
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
 * token). Opened from the toolbar; values persist to localStorage. */
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

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.popover} onClick={event => event.stopPropagation()}>
        <div className={styles.title}>Connection</div>
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
        <label className={styles.field}>
          <span>Bearer token</span>
          <input
            type="password"
            value={token}
            placeholder="none"
            autoComplete="off"
            onChange={event => setToken(event.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <button className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.save} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
