import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { streamAppAction } from '../../api/apps';
import type {
  AgentUsage,
  AppDefinition,
  AppLayoutItem,
  AppVariableValue,
} from '../../api/types';
import { Markdown } from '../../components/Markdown';
import styles from './AppsScreen.module.css';

export interface AppsScreenProps {
  client: ApiClient;
  onUnauthorized: () => void;
  app?: AppDefinition;
  loading?: boolean;
  loadError?: string;
  onBusyChange?: (busy: boolean) => void;
}

interface RunMetrics {
  latencyMs?: number;
  usage?: AgentUsage;
}

const ignoreBusyChange = () => {};

export function AppsScreen({
  client,
  onUnauthorized,
  app,
  loading = false,
  loadError,
  onBusyChange = ignoreBusyChange,
}: AppsScreenProps) {
  const [values, setValues] = useState<Record<string, AppVariableValue>>({});
  const [runningAction, setRunningAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [metrics, setMetrics] = useState<RunMetrics>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const valuesRef = useRef<Record<string, AppVariableValue>>({});

  useEffect(() => {
    abortRef.current?.abort();
    setRunningAction(undefined);
    if (!app) {
      valuesRef.current = {};
      setValues({});
      setActionError(undefined);
      setMetrics(undefined);
      return;
    }
    const nextValues = initialValues(app);
    valuesRef.current = nextValues;
    setValues(nextValues);
    setActionError(undefined);
    setMetrics(undefined);
  }, [app]);

  useEffect(() => {
    onBusyChange(runningAction !== undefined);
    return () => onBusyChange(false);
  }, [onBusyChange, runningAction]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function setValue(name: string, value: AppVariableValue): void {
    const nextValues = { ...valuesRef.current, [name]: value };
    valuesRef.current = nextValues;
    setValues(nextValues);
  }

  async function run(actionName: string): Promise<void> {
    if (!app || runningAction) return;
    const action = app.actions.find(candidate => candidate.name === actionName);
    if (!action) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunningAction(actionName);
    setActionError(undefined);
    setMetrics(undefined);
    setValue(action.output, '');
    let output = '';
    try {
      for await (const event of streamAppAction(
        client,
        app.app.name,
        actionName,
        {
          values: editableValues(app, valuesRef.current),
        },
        abort.signal,
      )) {
        if (event.type === 'chunk') {
          output += event.text;
          setValue(action.output, output);
        } else if (event.type === 'error') {
          setActionError(event.message);
        } else if (event.type === 'done') {
          setMetrics({ latencyMs: event.latencyMs, usage: event.usage });
        }
      }
    } catch (reason) {
      if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') onUnauthorized();
      if (!abort.signal.aborted) setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (abortRef.current === abort) abortRef.current = undefined;
      setRunningAction(undefined);
    }
  }

  return (
    <main className={styles.workspace}>
      {loading ? (
        <WorkspaceEmptyState title="Loading apps…" detail="~/.marifold/apps" />
      ) : app ? (
        <>
          <header className={styles.header}>
            <div>
              <h1>{app.app.title}</h1>
              {app.app.description ? <p>{app.app.description}</p> : null}
            </div>
            {app.app.version ? <span className={styles.version}>v{app.app.version}</span> : null}
          </header>
          <div className={styles.appCanvas}>
            {app.layout.map((item, index) => (
              <LayoutItem
                app={app}
                busy={runningAction !== undefined}
                item={item}
                key={`${item.component}-${index}`}
                onAction={action => void run(action)}
                onChange={setValue}
                values={values}
              />
            ))}
            {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}
            {runningAction ? <div className={styles.status}>Running {runningAction}…</div> : null}
            {metrics ? <div className={styles.metrics}>{formatMetrics(metrics)}</div> : null}
          </div>
        </>
      ) : (
        <WorkspaceEmptyState
          title={loadError ? 'Could not load apps' : 'No Apps yet'}
          detail={loadError ?? 'Add an <app-name>/app.toml bundle to ~/.marifold/apps.'}
        />
      )}
    </main>
  );
}

function LayoutItem({
  app,
  busy,
  item,
  onAction,
  onChange,
  values,
}: {
  app: AppDefinition;
  busy: boolean;
  item: AppLayoutItem;
  onAction: (name: string) => void;
  onChange: (name: string, value: AppVariableValue) => void;
  values: Record<string, AppVariableValue>;
}) {
  const variable = item.bind
    ? app.variables.find(candidate => candidate.name === item.bind)
    : undefined;
  const value = item.bind ? values[item.bind] : undefined;
  const containerClass = item.component === 'row'
    ? `${styles.row} ${item.responsive === 'stack' ? styles.stackResponsive : ''}`
    : styles.column;

  if (item.component === 'row' || item.component === 'column') {
    return (
      <div className={`${containerClass} ${styles[`gap_${item.gap ?? 'medium'}`]}`}>
        {item.children?.map((child, index) => (
          <div
            className={child.grow || child.component === 'spacer' ? styles.grow : undefined}
            key={`${child.component}-${index}`}
          >
            <LayoutItem {...{ app, busy, item: child, onAction, onChange, values }} />
          </div>
        ))}
      </div>
    );
  }
  if (item.component === 'spacer') return <span aria-hidden className={styles.spacer} />;
  if (item.component === 'text') return <p className={styles.text}>{item.content}</p>;
  if (item.component === 'button') {
    return (
      <button className={styles.primaryButton} disabled={busy} onClick={() => item.action && onAction(item.action)} type="button">
        {item.label ?? 'Run'}
      </button>
    );
  }
  if (item.component === 'preview') {
    const source = typeof value === 'string' ? value : String(value ?? '');
    return (
      <section className={styles.field}>
        {item.label ?? variable?.label ? <div className={styles.label}>{item.label ?? variable?.label}</div> : null}
        <div className={styles.preview}>
          {source
            ? item.format === 'markdown' ? <Markdown source={source} /> : <pre>{source}</pre>
            : <span className={styles.previewEmpty}>Output will appear here.</span>}
        </div>
      </section>
    );
  }
  if (!item.bind || !variable) return null;

  const label = item.label ?? variable.label ?? variable.name;
  const fieldLabel = (
    <span className={item.showLabel === false ? styles.visuallyHidden : styles.label}>
      {label}
    </span>
  );
  if (item.component === 'select') {
    return (
      <label className={styles.field}>
        {fieldLabel}
        <select
          disabled={busy}
          onChange={event => onChange(item.bind!, event.target.value)}
          value={String(value ?? '')}
        >
          {variable.options?.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    );
  }
  if (item.component === 'textarea') {
    return (
      <label className={styles.field}>
        {fieldLabel}
        <textarea
          disabled={busy}
          onChange={event => onChange(item.bind!, event.target.value)}
          required={variable.required}
          value={String(value ?? '')}
        />
      </label>
    );
  }
  if (item.component === 'text_input') {
    return (
      <label className={styles.field}>
        {fieldLabel}
        <input
          disabled={busy}
          onChange={event => onChange(
            item.bind!,
            variable.type === 'number' ? Number(event.target.value) : event.target.value,
          )}
          required={variable.required}
          type={variable.type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
        />
      </label>
    );
  }
  return null;
}

function WorkspaceEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.placeholder}>
      <div className={styles.placeholderTitle}>{title}</div>
      <div className={styles.placeholderHint}>{detail}</div>
    </div>
  );
}

function initialValues(app: AppDefinition): Record<string, AppVariableValue> {
  return Object.fromEntries(app.variables.map(variable => [
    variable.name,
    variable.default
      ?? (variable.type === 'number' ? 0
        : variable.type === 'boolean' ? false
          : variable.type === 'enum' ? variable.options?.[0] ?? ''
            : ''),
  ]));
}

function editableValues(
  app: AppDefinition,
  values: Record<string, AppVariableValue>,
): Record<string, AppVariableValue> {
  return Object.fromEntries(
    app.variables
      .filter(variable => variable.role !== 'output')
      .map(variable => [variable.name, values[variable.name] ?? '']),
  );
}

function formatMetrics(metrics: RunMetrics): string {
  const parts: string[] = [];
  if (metrics.latencyMs !== undefined) parts.push(`${formatSeconds(metrics.latencyMs)}s`);
  if (metrics.usage?.totalTokens !== undefined) parts.push(`${formatTokens(metrics.usage.totalTokens)} tokens`);
  return parts.join(' · ');
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '');
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(tokens);
}
