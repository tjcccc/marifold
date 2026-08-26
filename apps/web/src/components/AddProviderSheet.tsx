import { useEffect, useRef, useState } from 'react';
import type { AddProviderInput, ProviderCatalogEntry } from '../api/misc';
import styles from './AddProviderSheet.module.css';

const KIND_LABELS: Record<ProviderCatalogEntry['kind'], string> = {
  local: 'Local',
  api: 'API key',
  oauth: 'OAuth',
};

export interface AddProviderSheetProps {
  catalog?: ProviderCatalogEntry[];
  existingNames: string[];
  busy: boolean;
  error?: string;
  onSubmit: (input: AddProviderInput) => void;
  onClose: () => void;
}

/** Catalog-driven provider setup. The service supplies the same ordered
 * registry used by `marifold provider add`; this component only collects the
 * non-secret connection fields needed for that chosen entry. */
export function AddProviderSheet(props: AddProviderSheetProps) {
  const [selectedName, setSelectedName] = useState<string>();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [proxy, setProxy] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const firstSetupRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(props.onClose);
  const busyRef = useRef(props.busy);
  closeRef.current = props.onClose;
  busyRef.current = props.busy;

  const selected = props.catalog?.find(entry => entry.name === selectedName);
  const existing = new Set(props.existingNames);
  const firstAvailableName = props.catalog?.find(entry => !existing.has(entry.name))?.name;
  const needsBaseUrl = selected?.type === 'ollama' || selected?.type === 'openai-compatible';
  const needsApiKeyEnv = selected?.kind === 'api';
  const baseUrlMissing = Boolean(needsBaseUrl && !baseUrl.trim());
  const apiKeyEnvMissing = Boolean(needsApiKeyEnv && !apiKeyEnv.trim());
  const canSubmit = Boolean(selected && !baseUrlMissing && !apiKeyEnvMissing && !props.busy);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busyRef.current) {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      ) ?? [])];
      if (controls.length === 0) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = current < 0
        ? event.shiftKey ? controls.length - 1 : 0
        : event.shiftKey
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
  }, []);

  useEffect(() => {
    if (selected) firstSetupRef.current?.focus();
    else (firstOptionRef.current ?? closeButtonRef.current)?.focus();
  }, [selected, firstAvailableName]);

  function choose(entry: ProviderCatalogEntry): void {
    if (existing.has(entry.name)) return;
    setSelectedName(entry.name);
    setBaseUrl(entry.defaultBaseUrl ?? '');
    setApiKeyEnv(entry.apiKeyEnv ?? '');
    setProxy('');
  }

  function submit(): void {
    if (!selected || !canSubmit) return;
    props.onSubmit({
      name: selected.name,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
      ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
    });
  }

  return (
    <div className={styles.backdrop} onClick={props.busy ? undefined : props.onClose}>
      <div
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-provider-title"
        onClick={event => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <div id="add-provider-title" className={styles.title}>Add provider</div>
            <div className={styles.subtitle}>
              {selected ? `${selected.name} — ${selected.label}` : 'Choose from the same catalog as the CLI.'}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.close}
            aria-label="Close"
            disabled={props.busy}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>

        {!selected ? (
          <div className={styles.catalog} aria-label="Provider catalog">
            {props.catalog === undefined ? <div className={styles.empty}>Loading providers…</div> : null}
            {props.catalog?.map(entry => {
              const configured = existing.has(entry.name);
              return (
                <button
                  key={entry.name}
                  ref={entry.name === firstAvailableName ? firstOptionRef : undefined}
                  type="button"
                  className={styles.providerOption}
                  disabled={configured || props.busy}
                  onClick={() => choose(entry)}
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{entry.name}</span>
                    <span className={styles.optionLabel}>{entry.label}</span>
                  </span>
                  <span className={configured ? styles.configured : styles.kind}>
                    {configured ? 'Configured' : KIND_LABELS[entry.kind]}
                  </span>
                </button>
              );
            })}
            {props.error ? <div className={styles.problem}>{props.error}</div> : null}
          </div>
        ) : (
          <form
            className={styles.setup}
            onSubmit={event => {
              event.preventDefault();
              submit();
            }}
          >
            <button
              type="button"
              className={styles.back}
              disabled={props.busy}
              onClick={() => setSelectedName(undefined)}
            >
              ‹ All providers
            </button>

            <div className={styles.metadata}>
              <span>Type</span>
              <code>{selected.type}</code>
              <span>Authentication</span>
              <span>{KIND_LABELS[selected.kind]}</span>
            </div>

            {needsBaseUrl ? (
              <label className={styles.field}>
                <span>Server URL</span>
                <input
                  ref={firstSetupRef}
                  value={baseUrl}
                  disabled={props.busy}
                  placeholder="https://llm.example.com/v1"
                  onChange={event => setBaseUrl(event.target.value)}
                />
                {baseUrlMissing ? <small>A server URL is required.</small> : null}
              </label>
            ) : null}

            {needsApiKeyEnv ? (
              <label className={styles.field}>
                <span>API key environment variable</span>
                <input
                  ref={needsBaseUrl ? undefined : firstSetupRef}
                  value={apiKeyEnv}
                  disabled={props.busy}
                  placeholder="PROVIDER_API_KEY"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={event => setApiKeyEnv(event.target.value)}
                />
                {apiKeyEnvMissing ? <small>An environment-variable name is required.</small> : null}
              </label>
            ) : null}

            <label className={styles.field}>
              <span>Proxy <small>optional</small></span>
              <input
                ref={!needsBaseUrl && !needsApiKeyEnv ? firstSetupRef : undefined}
                value={proxy}
                disabled={props.busy}
                placeholder="http://127.0.0.1:7890"
                onChange={event => setProxy(event.target.value)}
              />
            </label>

            <div className={styles.hint}>
              {selected.kind === 'oauth'
                ? 'After adding, use Re-authenticate on the provider page to sign in from the service host.'
                : selected.kind === 'api'
                  ? 'Store the key in this environment variable on the service host; raw keys never cross the Web API.'
                  : 'The server must be reachable from the machine running the marifold service.'}
            </div>

            {props.error ? <div className={styles.problem}>{props.error}</div> : null}

            <div className={styles.actions}>
              <button type="button" className={styles.cancel} disabled={props.busy} onClick={props.onClose}>
                Cancel
              </button>
              <button type="submit" className={styles.add} disabled={!canSubmit}>
                {props.busy ? 'Adding…' : `Add ${selected.name}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
