import { useState } from 'react';
import type { ProviderStatusEntry } from '../../api/misc';
import type { PublicConfig } from '../../api/types';
import styles from './SystemPages.module.css';

const PROVIDER_TYPES = ['ollama', 'openai-compatible', 'anthropic'] as const;

export interface AddProviderInput {
  name: string;
  type: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  proxy?: string;
}

export interface ProvidersPageProps {
  selected?: string;
  config?: PublicConfig;
  status?: ProviderStatusEntry[];
  busy: boolean;
  /** key ∈ base_url | api_key_env | type — the PATCH /v1/config dotted keys.
   * Raw api_key values are deliberately not editable here (CLI/file only). */
  onSaveField: (name: string, key: string, value: string) => void;
  onRefreshStatus: () => void;
  onAddProvider: (input: AddProviderInput) => Promise<void>;
}

/** Provider detail + add form. Reachability comes from /v1/providers/status. */
export function ProvidersPage(props: ProvidersPageProps) {
  const provider = props.selected ? props.config?.providers[props.selected] : undefined;
  const status = props.status?.find(entry => entry.name === props.selected);
  const [baseUrl, setBaseUrl] = useState<string | undefined>();
  const [apiKeyEnv, setApiKeyEnv] = useState<string | undefined>();
  const [proxy, setProxy] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  // Reset drafts when the selection changes (render-time state sync).
  const [draftFor, setDraftFor] = useState(props.selected);
  if (draftFor !== props.selected) {
    setDraftFor(props.selected);
    setBaseUrl(undefined);
    setApiKeyEnv(undefined);
    setProxy(undefined);
    setAdding(false);
  }

  if (adding) {
    return (
      <AddProviderForm
        busy={props.busy}
        existing={Object.keys(props.config?.providers ?? {})}
        onSubmit={input => void props.onAddProvider(input).then(() => setAdding(false))}
        onCancel={() => setAdding(false)}
      />
    );
  }

  if (!props.selected || !provider) {
    return <div className={styles.empty}>Select a provider.</div>;
  }

  const baseUrlValue = baseUrl ?? provider.baseUrl ?? '';
  const apiKeyEnvValue = apiKeyEnv ?? provider.apiKeyEnv ?? '';
  const proxyValue = proxy ?? provider.proxy ?? '';

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
          <button className={styles.linkAction} onClick={props.onRefreshStatus} disabled={props.busy}>
            Refresh status
          </button>
          <button className={styles.linkAction} onClick={() => setAdding(true)} disabled={props.busy}>
            Add provider…
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
            <span className={styles.fieldHint}> — raw keys are edited via the CLI or config file only</span>
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
    </div>
  );
}

function AddProviderForm({
  busy,
  existing,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  existing: string[];
  onSubmit: (input: AddProviderInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [proxy, setProxy] = useState('');

  const trimmed = name.trim();
  const problem =
    trimmed.length > 0 && !/^[A-Za-z0-9_-]+$/.test(trimmed)
      ? 'Letters, numbers, underscores, and hyphens only.'
      : existing.includes(trimmed)
        ? `'${trimmed}' already exists.`
        : undefined;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitle}>Add provider</div>
      </header>
      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Name</span>
          <input className={styles.input} value={name} placeholder="myremote" autoFocus onChange={event => setName(event.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Type</span>
          <select className={styles.select} value={type} onChange={event => setType(event.target.value)}>
            {PROVIDER_TYPES.map(candidate => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Base URL</span>
          <input className={styles.input} value={baseUrl} placeholder="https://llm.example.com/v1" onChange={event => setBaseUrl(event.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>API key env</span>
          <input className={styles.input} value={apiKeyEnv} placeholder="MYREMOTE_API_KEY" onChange={event => setApiKeyEnv(event.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Proxy</span>
          <input className={styles.input} value={proxy} placeholder="http://127.0.0.1:7890 — blank = direct" onChange={event => setProxy(event.target.value)} />
        </div>
      </section>
      {problem ? <div className={styles.problem}>{problem}</div> : null}
      <div className={styles.formActions}>
        <button className={styles.cancelAction} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className={styles.primaryAction}
          disabled={busy || trimmed.length === 0 || problem !== undefined}
          onClick={() =>
            onSubmit({
              name: trimmed,
              type,
              ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
              ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
            })
          }
        >
          Add provider
        </button>
      </div>
    </div>
  );
}
