import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderStatusEntry } from '../../api/misc';
import type { PublicConfig } from '../../api/types';
import { CopyButton } from '../../components/CopyButton';
import styles from './SystemPages.module.css';

const PROVIDER_TYPES = ['ollama', 'openai-compatible', 'anthropic'] as const;
const OAUTH_PROVIDERS = new Set(['github_copilot', 'chatgpt', 'xai']);

export interface ProvidersPageProps {
  selected?: string;
  config?: PublicConfig;
  status?: ProviderStatusEntry[];
  busy: boolean;
  /** key ∈ base_url | api_key_env | type — the PATCH /v1/config dotted keys.
   * Raw api_key values are deliberately not editable here (CLI/file only). */
  onSaveField: (name: string, key: string, value: string) => void;
  onRefreshStatus: () => void;
  onRemoveProvider: () => void;
  deleteDisabledReason?: string;
}

/** Provider detail + add form. Reachability comes from /v1/providers/status. */
export function ProvidersPage(props: ProvidersPageProps) {
  const provider = props.selected ? props.config?.providers[props.selected] : undefined;
  const status = props.status?.find(entry => entry.name === props.selected);
  const [baseUrl, setBaseUrl] = useState<string | undefined>();
  const [apiKeyEnv, setApiKeyEnv] = useState<string | undefined>();
  const [proxy, setProxy] = useState<string | undefined>();
  const [reauthOpen, setReauthOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeName, setRemoveName] = useState('');
  const reauthTriggerRef = useRef<HTMLButtonElement>(null);
  const reauthDialogRef = useRef<HTMLDivElement>(null);
  const reauthCloseRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const removeDialogRef = useRef<HTMLFormElement>(null);
  const removeInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(props.busy);
  busyRef.current = props.busy;

  // Reset drafts when the selection changes (render-time state sync).
  const [draftFor, setDraftFor] = useState(props.selected);
  if (draftFor !== props.selected) {
    setDraftFor(props.selected);
    setBaseUrl(undefined);
    setApiKeyEnv(undefined);
    setProxy(undefined);
    setReauthOpen(false);
    setRemoveOpen(false);
    setRemoveName('');
  }

  useEffect(() => {
    if (!removeOpen && !reauthOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = removeOpen ? removeDialogRef.current : reauthDialogRef.current;
    const returnFocus = removeOpen ? removeTriggerRef.current : reauthTriggerRef.current;
    if (removeOpen) removeInputRef.current?.focus();
    else reauthCloseRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busyRef.current) {
        setReauthOpen(false);
        setRemoveOpen(false);
        setRemoveName('');
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      ) ?? [])];
      if (controls.length === 0) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current - 1 + controls.length) % controls.length
        : (current + 1) % controls.length;
      event.preventDefault();
      controls[next]?.focus();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      returnFocus?.focus();
    };
  }, [removeOpen, reauthOpen]);

  if (!props.selected || !provider) {
    return <div className={styles.empty}>Select a provider.</div>;
  }

  const baseUrlValue = baseUrl ?? provider.baseUrl ?? '';
  const apiKeyEnvValue = apiKeyEnv ?? provider.apiKeyEnv ?? '';
  const proxyValue = proxy ?? provider.proxy ?? '';
  const removeConfirmed = removeName === props.selected;
  const supportsReauth = OAUTH_PROVIDERS.has(props.selected);
  const reauthCommand = `marifold provider reauth ${props.selected}`;

  function closeRemoveDialog(): void {
    if (props.busy) return;
    setRemoveOpen(false);
    setRemoveName('');
  }

  function closeReauthDialog(): void {
    setReauthOpen(false);
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>{props.selected}</div>
          <div className={styles.pageSub}>
            {provider.type}
            {status
              ? ` · ${status.reachable === true ? 'reachable' : status.reachable === false ? 'unreachable' : 'not probeable'}${status.modelCount !== undefined ? ` · ${status.modelCount} models` : ''}`
              : ' · probing…'}
          </div>
        </div>
        <div className={styles.pageActions}>
          {supportsReauth ? (
            <button
              ref={reauthTriggerRef}
              className={styles.linkAction}
              onClick={() => setReauthOpen(true)}
              disabled={props.busy}
            >
              Re-authenticate…
            </button>
          ) : null}
          <button className={styles.linkAction} onClick={props.onRefreshStatus} disabled={props.busy}>
            Refresh status
          </button>
        </div>
      </header>

      {status?.message ? <div className={styles.note}>{status.message}</div> : null}

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Type</span>
          <select
            className={styles.select}
            value={provider.type}
            disabled={props.busy}
            onChange={event => props.onSaveField(props.selected!, 'type', event.target.value)}
          >
            {PROVIDER_TYPES.map(type => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Base URL</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={baseUrlValue}
              placeholder="http://localhost:11434"
              onChange={event => setBaseUrl(event.target.value)}
            />
            {baseUrl !== undefined && baseUrl !== (provider.baseUrl ?? '') ? (
              <button
                className={styles.saveAction}
                disabled={props.busy}
                onClick={() => {
                  props.onSaveField(props.selected!, 'base_url', baseUrl.trim());
                  setBaseUrl(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>API key env</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={apiKeyEnvValue}
              placeholder="MYPROVIDER_API_KEY"
              onChange={event => setApiKeyEnv(event.target.value)}
            />
            {apiKeyEnv !== undefined && apiKeyEnv !== (provider.apiKeyEnv ?? '') ? (
              <button
                className={styles.saveAction}
                disabled={props.busy}
                onClick={() => {
                  props.onSaveField(props.selected!, 'api_key_env', apiKeyEnv.trim());
                  setApiKeyEnv(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Proxy</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={proxyValue}
              placeholder="http://127.0.0.1:7890 — blank = direct"
              onChange={event => setProxy(event.target.value)}
            />
            {proxy !== undefined && proxy !== (provider.proxy ?? '') ? (
              <button
                className={styles.saveAction}
                disabled={props.busy}
                onClick={() => {
                  props.onSaveField(props.selected!, 'proxy', proxy.trim());
                  setProxy(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Credentials</span>
          <span className={styles.fieldStatic}>
            {provider.hasApiKey ? 'API key configured' : provider.hasOauthToken ? 'OAuth token configured' : 'none stored'}
            <span className={styles.fieldHint}>
              {supportsReauth
                ? ' — use Re-authenticate to replace saved credentials'
                : ' — raw keys are edited via the CLI or config file only'}
            </span>
          </span>
        </div>
      </section>

      {status && status.models.length > 0 ? (
        <section className={styles.card}>
          <div className={styles.cardTitle}>Available models</div>
          <div className={styles.modelList}>
            {status.models.map(model => (
              <span key={model} className={styles.modelChipStatic}>
                {model}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Remove provider">
        <div className={styles.dangerCard}>
          <div>
            <div className={styles.dangerTitle}>Remove this provider</div>
            <div className={styles.dangerDescription}>
              Deletes its local configuration, stored credentials, and saved model options.
            </div>
          </div>
          <button
            ref={removeTriggerRef}
            className={styles.dangerAction}
            disabled={props.busy || Boolean(props.deleteDisabledReason)}
            title={props.deleteDisabledReason}
            onClick={() => {
              setRemoveName('');
              setRemoveOpen(true);
            }}
          >
            Remove
          </button>
        </div>
        {props.deleteDisabledReason ? (
          <div className={styles.dangerHint}>{props.deleteDisabledReason}</div>
        ) : null}
      </section>

      {reauthOpen ? createPortal(
        <div className={styles.removeBackdrop} onClick={closeReauthDialog}>
          <div
            ref={reauthDialogRef}
            className={styles.removeDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reauth-provider-title"
            aria-describedby="reauth-provider-description"
            onClick={event => event.stopPropagation()}
          >
            <div id="reauth-provider-title" className={styles.removeDialogTitle}>
              Re-authenticate “{props.selected}”
            </div>
            <div id="reauth-provider-description" className={styles.removeDialogDescription}>
              Run this on the machine hosting the Marifold service. OAuth uses a host-local callback,
              so starting it inside a remotely forwarded Web UI would target the wrong machine.
            </div>
            <div className={styles.commandBox}>
              <code>{reauthCommand}</code>
              <CopyButton
                text={reauthCommand}
                label="Copy re-authentication command"
                className={styles.commandCopy}
              />
            </div>
            <div className={styles.reauthHint}>
              Provider settings and saved model choices are preserved; only credentials are replaced.
            </div>
            <div className={styles.removeDialogActions}>
              <button
                ref={reauthCloseRef}
                type="button"
                className={styles.removeDialogCancel}
                onClick={closeReauthDialog}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {removeOpen ? createPortal(
        <div className={styles.removeBackdrop} onClick={closeRemoveDialog}>
          <form
            ref={removeDialogRef}
            className={styles.removeDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-provider-title"
            aria-describedby="remove-provider-description"
            onClick={event => event.stopPropagation()}
            onSubmit={event => {
              event.preventDefault();
              if (removeConfirmed && !props.busy) props.onRemoveProvider();
            }}
          >
            <div id="remove-provider-title" className={styles.removeDialogTitle}>
              Remove “{props.selected}”?
            </div>
            <div id="remove-provider-description" className={styles.removeDialogDescription}>
              Its local configuration, credentials, and saved model options will be permanently deleted.
              Provider-owned models and remote accounts are not affected.
            </div>
            <label className={styles.removeConfirmLabel}>
              <span>Type <strong>{props.selected}</strong> to confirm</span>
              <input
                ref={removeInputRef}
                className={styles.removeConfirmInput}
                aria-label="Provider name confirmation"
                autoComplete="off"
                spellCheck={false}
                value={removeName}
                disabled={props.busy}
                onChange={event => setRemoveName(event.target.value)}
              />
            </label>
            <div className={styles.removeDialogActions}>
              <button
                type="button"
                className={styles.removeDialogCancel}
                disabled={props.busy}
                onClick={closeRemoveDialog}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.removeDialogDelete}
                disabled={props.busy || !removeConfirmed}
              >
                {props.busy ? 'Removing…' : 'Remove provider'}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
