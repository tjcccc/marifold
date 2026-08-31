import { useState } from 'react';
import type { PublicConfig } from '../../api/types';
import styles from './SystemPages.module.css';

export interface WebSearchPageProps {
  search?: PublicConfig['webSearch'];
  busy: boolean;
  onSave: (key: string, value: string) => void;
}

export function WebSearchPage({ search, busy, onSave }: WebSearchPageProps) {
  const [maxResults, setMaxResults] = useState<string>();
  const [apiKeyEnv, setApiKeyEnv] = useState<string>();
  const [proxy, setProxy] = useState<string>();

  if (!search) return <div className={styles.empty}>Loading web search settings…</div>;
  const keyEnvValue = apiKeyEnv ?? search.apiKeyEnv ?? '';
  const proxyValue = proxy ?? search.proxy ?? '';

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Web search</div>
          <div className={styles.pageSub}>Configure Marifold's fallback search. Supported models use provider-hosted search first, even when this fallback is off.</div>
        </div>
      </header>

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Marifold fallback</span>
          <Toggle
            label="Marifold fallback"
            value={search.enabled}
            busy={busy}
            onChange={value => onSave('enabled', String(value))}
          />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="search-provider">Fallback provider</label>
          <select
            id="search-provider"
            className={styles.select}
            value={search.provider}
            disabled={busy}
            onChange={event => onSave('provider', event.target.value)}
          >
            <option value="duckduckgo">DuckDuckGo — keyless</option>
            <option value="firecrawl">Firecrawl</option>
            <option value="ollama">Ollama Cloud</option>
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="search-max-results">Maximum results</label>
          <div className={styles.fieldEdit}>
            <input
              id="search-max-results"
              className={styles.input}
              type="number"
              min={1}
              step={1}
              value={maxResults ?? String(search.maxResults)}
              onChange={event => setMaxResults(event.target.value)}
            />
            {maxResults !== undefined && maxResults !== String(search.maxResults) ? (
              <button
                className={styles.saveAction}
                type="button"
                disabled={busy || Number(maxResults) < 1}
                onClick={() => {
                  onSave('max_results', maxResults);
                  setMaxResults(undefined);
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Scrape result pages</span>
          <Toggle
            label="Scrape result pages"
            value={Boolean(search.scrape)}
            busy={busy || search.provider !== 'firecrawl'}
            onChange={value => onSave('scrape', String(value))}
          />
        </div>
      </section>

      {search.provider === 'ollama' ? (
        <div className={styles.note}>
          Ollama search is an account-backed cloud service. Queries leave this machine for ollama.com; local Ollama models still call it through Marifold's fallback tool.
        </div>
      ) : null}

      <section className={styles.card}>
        <div className={styles.cardTitle}>Connection</div>
        <EditableText
          id="search-key-env"
          label="API key env"
          value={keyEnvValue}
          changed={apiKeyEnv !== undefined && apiKeyEnv !== (search.apiKeyEnv ?? '')}
          placeholder={search.provider === 'ollama' ? 'OLLAMA_API_KEY' : 'FIRECRAWL_API_KEY'}
          busy={busy}
          onChange={setApiKeyEnv}
          onSave={() => {
            onSave('api_key_env', apiKeyEnv?.trim() ?? '');
            setApiKeyEnv(undefined);
          }}
        />
        <EditableText
          id="search-proxy"
          label="Proxy"
          value={proxyValue}
          changed={proxy !== undefined && proxy !== (search.proxy ?? '')}
          placeholder="http://127.0.0.1:7890"
          busy={busy}
          onChange={setProxy}
          onSave={() => {
            onSave('proxy', proxy?.trim() ?? '');
            setProxy(undefined);
          }}
        />
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Inline API key</span>
          <span className={styles.fieldStatic}>
            {search.hasApiKey ? 'configured' : 'not configured'}
            <span className={styles.fieldHint}> — the value never crosses the wire</span>
          </span>
        </div>
      </section>
    </div>
  );
}

function Toggle({
  label,
  value,
  busy,
  onChange,
}: {
  label: string;
  value: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {[true, false].map(option => (
        <button
          key={String(option)}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={value === option ? styles.segmentActive : styles.segment}
          disabled={busy}
          onClick={() => onChange(option)}
        >
          {option ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );
}

function EditableText({
  id,
  label,
  value,
  changed,
  placeholder,
  busy,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  changed: boolean;
  placeholder: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      <div className={styles.fieldEdit}>
        <input
          id={id}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          onChange={event => onChange(event.target.value)}
        />
        {changed ? (
          <button className={styles.saveAction} type="button" disabled={busy} onClick={onSave}>Save</button>
        ) : null}
      </div>
    </div>
  );
}
