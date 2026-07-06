import { useState } from 'react';
import type { PublicConfig } from '../../api/types';
import styles from './SystemPages.module.css';

export interface ServicePageProps {
  service?: PublicConfig['service'];
  busy: boolean;
  /** key ∈ web_dir | cors_origins | token_env (PATCH /v1/config `service.*`). */
  onSave: (key: string, value: string) => void;
}

/** The sanitized [service] section — hosting dir, CORS allowlist, token env.
 * The token value itself never crosses the wire (hasToken only). */
export function ServicePage({ service, busy, onSave }: ServicePageProps) {
  const [webDir, setWebDir] = useState<string | undefined>();
  const [cors, setCors] = useState<string | undefined>();
  const [tokenEnv, setTokenEnv] = useState<string | undefined>();

  const webDirValue = webDir ?? service?.webDir ?? '';
  const corsValue = cors ?? (service?.corsOrigins ?? []).join(', ');
  const tokenEnvValue = tokenEnv ?? service?.tokenEnv ?? '';

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Service</div>
          <div className={styles.pageSub}>Changes take effect after a service restart.</div>
        </div>
      </header>

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Web UI directory</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={webDirValue}
              placeholder="/path/to/apps/web/dist"
              onChange={event => setWebDir(event.target.value)}
            />
            {webDir !== undefined && webDir !== (service?.webDir ?? '') ? (
              <button
                className={styles.saveAction}
                disabled={busy}
                onClick={() => {
                  onSave('web_dir', webDir.trim());
                  setWebDir(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>CORS origins</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={corsValue}
              placeholder="http://localhost:5173, https://app.example.com"
              onChange={event => setCors(event.target.value)}
            />
            {cors !== undefined && cors !== (service?.corsOrigins ?? []).join(', ') ? (
              <button
                className={styles.saveAction}
                disabled={busy}
                onClick={() => {
                  onSave('cors_origins', cors.trim());
                  setCors(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Token env</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={tokenEnvValue}
              placeholder="MARIFOLD_SERVICE_TOKEN"
              onChange={event => setTokenEnv(event.target.value)}
            />
            {tokenEnv !== undefined && tokenEnv !== (service?.tokenEnv ?? '') ? (
              <button
                className={styles.saveAction}
                disabled={busy}
                onClick={() => {
                  onSave('token_env', tokenEnv.trim());
                  setTokenEnv(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Bearer token</span>
          <span className={styles.fieldStatic}>
            {service?.hasToken ? 'configured' : 'not configured'}
            <span className={styles.fieldHint}> — the value itself never crosses the wire</span>
          </span>
        </div>
      </section>
    </div>
  );
}
