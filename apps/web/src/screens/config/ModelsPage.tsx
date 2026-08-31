import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { AddModelInput, ModelsView } from '../../api/misc';
import { getProviderModels } from '../../api/misc';
import styles from './SystemPages.module.css';

export interface ModelsPageProps {
  client: ApiClient;
  models?: ModelsView;
  /** Configured provider names for the add form. */
  providers: string[];
  busy: boolean;
  onSetDefault: (provider: string, model: string) => Promise<void>;
  onRemove: (provider: string, model: string) => Promise<void>;
  onAdd: (input: AddModelInput) => Promise<void>;
}

/** Saved model options + the global default (CLI `model list/add/rm/default`). */
export function ModelsPage(props: ModelsPageProps) {
  const [addProvider, setAddProvider] = useState('');
  const [addModelName, setAddModelName] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsFor, setSuggestionsFor] = useState<string | undefined>();

  if (!props.models) return <div className={styles.empty}>Loading…</div>;

  const currentDefault =
    props.models.default.provider && props.models.default.model
      ? `${props.models.default.provider}/${props.models.default.model}`
      : '';

  async function loadSuggestions(provider: string): Promise<void> {
    if (!provider || provider === suggestionsFor) return;
    setSuggestionsFor(provider);
    try {
      const live = await getProviderModels(props.client, provider);
      setSuggestions(live.models);
    } catch {
      setSuggestions([]);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitle}>Models</div>
      </header>

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Default model</span>
          <select
            className={styles.select}
            value={currentDefault}
            disabled={props.busy}
            onChange={event => {
              const slash = event.target.value.indexOf('/');
              if (slash > 0) {
                void props.onSetDefault(event.target.value.slice(0, slash), event.target.value.slice(slash + 1));
              }
            }}
          >
            {currentDefault === '' ? <option value="">— not set —</option> : null}
            {props.models.options.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Saved options</div>
        {props.models.options.length === 0 ? <div className={styles.note}>No saved options yet.</div> : null}
        {props.models.options.map(option => {
          const slash = option.indexOf('/');
          const provider = option.slice(0, slash);
          const model = option.slice(slash + 1);
          return (
            <div key={option} className={styles.optionRow}>
              <span className={styles.optionName}>
                {option}
                {option === currentDefault ? <span className={styles.defaultTag}> default</span> : null}
              </span>
              <button
                className={styles.removeAction}
                title={`Remove ${option}`}
                aria-label={`Remove ${option}`}
                disabled={props.busy}
                onClick={() => void props.onRemove(provider, model)}
              >
                ×
              </button>
            </div>
          );
        })}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Add model</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Provider</span>
          <select
            className={`${styles.select} ${styles.addProviderSelect}`}
            value={addProvider}
            onChange={event => {
              setAddProvider(event.target.value);
              void loadSuggestions(event.target.value);
            }}
          >
            <option value="">— choose —</option>
            {props.providers.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Model</span>
          <div className={styles.fieldEdit}>
            <input
              className={styles.input}
              value={addModelName}
              placeholder="model-name"
              list="model-suggestions"
              onChange={event => setAddModelName(event.target.value)}
            />
            <datalist id="model-suggestions">
              {suggestions.map(model => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <button
              className={styles.saveAction}
              disabled={props.busy || !addProvider || addModelName.trim().length === 0}
              onClick={() => {
                void props
                  .onAdd({ provider: addProvider, model: addModelName.trim() })
                  .then(() => setAddModelName(''));
              }}
            >
              Add
            </button>
          </div>
        </div>
        {suggestionsFor && suggestions.length > 0 ? (
          <div className={styles.note}>
            {suggestions.length} models live on {suggestionsFor} — the field suggests them as you type.
          </div>
        ) : null}
      </section>
    </div>
  );
}
