import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import {
  createSkillAppInstance,
  deleteSkillAppInstance,
  runSkillAppOperation,
  updateSkillAppState,
} from '../../api/apps';
import type {
  AgentUsage,
  SkillAppDefinition,
  SkillAppLayoutItem,
  SkillAppMutationResult,
} from '../../api/types';
import styles from './AppsScreen.module.css';

export interface AppsScreenProps {
  client: ApiClient;
  onUnauthorized: () => void;
  app?: SkillAppDefinition;
  loading?: boolean;
  loadError?: string;
  onBusyChange?: (busy: boolean) => void;
}

interface RunMetrics {
  latencyMs?: number;
  usage?: AgentUsage;
}

type ActivityTone = 'info' | 'success' | 'warning' | 'error';

interface ActivityEntry {
  id: number;
  createdAt: Date;
  tone: ActivityTone;
  title: string;
  message?: string;
  metrics?: RunMetrics;
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
  const [values, setValues] = useState<Record<string, string>>(() => app ? initialValues(app) : {});
  const [pending, setPending] = useState(0);
  const [runningOperation, setRunningOperation] = useState<string>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const instanceRef = useRef<string | undefined>(undefined);
  const valuesRef = useRef<Record<string, string>>(app ? initialValues(app) : {});
  const mutationVersion = useRef(0);
  const appEpoch = useRef(0);
  const activityId = useRef(0);

  useEffect(() => {
    const epoch = ++appEpoch.current;
    let live = true;
    let createdId: string | undefined;
    const initial = app ? initialValues(app) : {};
    instanceRef.current = undefined;
    valuesRef.current = initial;
    setValues(initial);
    setActivity([]);
    setActivityOpen(false);
    setRunningOperation(undefined);

    if (!app) {
      setPending(0);
      return () => {
        live = false;
      };
    }

    setPending(1);
    void createSkillAppInstance(client, app.app.name)
      .then(instance => {
        createdId = instance.id;
        if (!live) return deleteSkillAppInstance(client, instance.id);
        instanceRef.current = instance.id;
        valuesRef.current = instance.state;
        setValues(instance.state);
      })
      .catch(reason => {
        if (!live) return;
        if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') onUnauthorized();
        appendActivity('error', 'Could not open app', errorMessage(reason));
        setActivityOpen(true);
      })
      .finally(() => {
        if (live && epoch === appEpoch.current) setPending(0);
      });
    return () => {
      live = false;
      if (appEpoch.current === epoch) appEpoch.current += 1;
      mutationVersion.current += 1;
      instanceRef.current = undefined;
      if (createdId) void deleteSkillAppInstance(client, createdId).catch(() => {});
    };
  }, [app, client, onUnauthorized]);

  useEffect(() => {
    onBusyChange(pending > 0);
    return () => onBusyChange(false);
  }, [onBusyChange, pending]);

  useEffect(() => {
    if (!activityOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActivityOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [activityOpen]);

  function appendActivity(
    tone: ActivityTone,
    title: string,
    message?: string,
    metrics?: RunMetrics,
  ): void {
    const entry: ActivityEntry = {
      id: ++activityId.current,
      createdAt: new Date(),
      tone,
      title,
      ...(message ? { message } : {}),
      ...(metrics ? { metrics } : {}),
    };
    setActivity(current => [...current, entry]);
  }

  function setValue(name: string, value: string): void {
    if (!app) return;
    const nextValues = { ...valuesRef.current, [name]: value };
    for (const operation of app.operations) {
      if (operation.requiredInputs.includes(name) && !isOperationRunnable(operation.requiredInputs, nextValues)) {
        nextValues[operation.output] = '';
      }
    }
    valuesRef.current = nextValues;
    setValues(nextValues);
    setRunningOperation(undefined);

    const instanceId = instanceRef.current;
    if (!instanceId) return;
    const version = ++mutationVersion.current;
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    void updateSkillAppState(client, instanceId, { [name]: value })
      .then(result => applyMutation(result, version))
      .catch(reason => handleError(reason, version, 'Could not update app'))
      .finally(() => {
        if (epoch === appEpoch.current) setPending(current => Math.max(0, current - 1));
      });
  }

  function run(operationName: string): void {
    if (!app) return;
    const operation = app.operations.find(candidate => candidate.name === operationName);
    const instanceId = instanceRef.current;
    if (!operation || !instanceId || !isOperationRunnable(operation.requiredInputs, valuesRef.current)) return;

    const version = ++mutationVersion.current;
    const epoch = appEpoch.current;
    const label = humanize(operationName);
    setPending(current => current + 1);
    setRunningOperation(operationName);
    appendActivity('info', `${label} started`);
    void runSkillAppOperation(client, instanceId, operationName)
      .then(result => applyMutation(result, version))
      .catch(reason => handleError(reason, version, `${label} failed`))
      .finally(() => {
        if (epoch === appEpoch.current) setPending(current => Math.max(0, current - 1));
        if (version === mutationVersion.current) setRunningOperation(undefined);
      });
  }

  function applyMutation(result: SkillAppMutationResult, version: number): void {
    if (version !== mutationVersion.current || result.status === 'superseded') return;
    valuesRef.current = result.instance.state;
    setValues(result.instance.state);
    if (result.reason === 'missing_required_input') return;

    const label = humanize(result.operation ?? runningOperation ?? 'operation');
    if (result.result?.status === 'error') {
      appendActivity('error', `${label} failed`, result.result.error.message);
      setActivityOpen(true);
      return;
    }
    if (result.result?.status === 'ok') {
      appendActivity('success', `${label} completed`, undefined, {
        latencyMs: result.result.meta.durationMs,
        ...(result.result.meta.usage?.totalTokens !== undefined
          ? { usage: { totalTokens: result.result.meta.usage.totalTokens } }
          : {}),
      });
    }
  }

  function handleError(reason: unknown, version: number, title: string): void {
    if (version !== mutationVersion.current) return;
    if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') onUnauthorized();
    appendActivity('error', title, errorMessage(reason));
    setActivityOpen(true);
  }

  if (loading) {
    return (
      <main className={styles.workspace}>
        <WorkspaceEmptyState title="Loading apps…" detail="~/.marifold/apps" />
      </main>
    );
  }

  if (!app) {
    return (
      <main className={styles.workspace}>
        <WorkspaceEmptyState
          title={loadError ? 'Could not load apps' : 'No Apps yet'}
          detail={loadError ?? 'Add an <app-name>/skillapp.ts bundle to ~/.marifold/apps.'}
        />
      </main>
    );
  }

  const hasErrors = activity.some(entry => entry.tone === 'error');
  return (
    <main className={styles.workspace}>
      <div className={styles.scrollArea}>
        <header className={styles.header}>
          <hgroup>
            <h1>{app.app.title}</h1>
            {app.app.description ? <p>{app.app.description}</p> : null}
          </hgroup>
        </header>
        <div className={styles.appCanvas}>
          {app.layout.map((item, index) => (
            <SkillLayoutItem
              app={app}
              busy={pending > 0}
              item={item}
              key={`${item.component}-${index}`}
              onOperation={run}
              onChange={setValue}
              path={String(index)}
              ready={instanceRef.current !== undefined}
              values={values}
            />
          ))}
        </div>
      </div>

      {activityOpen ? (
        <section aria-label="App activity" className={styles.activityDrawer} id="skillapp-activity">
          <div className={styles.activityHeader}>
            <div>
              <h2>Activity</h2>
              <p>Runs, warnings, and errors for this app.</p>
            </div>
            <div className={styles.activityActions}>
              {activity.length > 0 ? (
                <button onClick={() => setActivity([])} type="button">Clear</button>
              ) : null}
              <button onClick={() => setActivityOpen(false)} type="button">Close</button>
            </div>
          </div>
          <div className={styles.activityList} role="log">
            {activity.length > 0 ? [...activity].reverse().map(entry => (
              <article className={`${styles.activityEntry} ${styles[`activity_${entry.tone}`]}`} key={entry.id}>
                <span aria-hidden className={styles.activityDot} />
                <div className={styles.activityBody}>
                  <div className={styles.activityTitleLine}>
                    <strong>{entry.title}</strong>
                    <time>{formatActivityTime(entry.createdAt)}</time>
                  </div>
                  {entry.message ? <p>{entry.message}</p> : null}
                  {entry.metrics && formatMetrics(entry.metrics) ? (
                    <div className={styles.activityMetrics}>{formatMetrics(entry.metrics)}</div>
                  ) : null}
                </div>
              </article>
            )) : (
              <div className={styles.activityEmpty}>No activity yet.</div>
            )}
          </div>
        </section>
      ) : null}

      <footer className={styles.appFooter}>
        <span>{app.app.version ? `v${app.app.version}` : app.app.name}</span>
        <span className={styles.footerActions}>
          {pending > 0 ? (
            <span className={styles.footerStatus} role="status">
              {runningOperation ? `Running ${humanize(runningOperation)}…` : 'Updating…'}
            </span>
          ) : null}
          <button
            aria-controls="skillapp-activity"
            aria-expanded={activityOpen}
            className={`${styles.activityButton} ${hasErrors ? styles.activityButtonError : ''}`}
            onClick={() => setActivityOpen(open => !open)}
            type="button"
          >
            Activity{activity.length > 0 ? ` (${activity.length})` : ''}
          </button>
        </span>
      </footer>
    </main>
  );
}

function SkillLayoutItem({
  app,
  busy,
  item,
  onOperation,
  onChange,
  path,
  ready,
  values,
}: {
  app: SkillAppDefinition;
  busy: boolean;
  item: SkillAppLayoutItem;
  onOperation: (name: string) => void;
  onChange: (name: string, value: string) => void;
  path: string;
  ready: boolean;
  values: Record<string, string>;
}) {
  const value = item.bind ? values[item.bind] ?? '' : '';
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
            <SkillLayoutItem
              {...{ app, busy, item: child, onOperation, onChange, ready, values }}
              path={`${path}-${index}`}
            />
          </div>
        ))}
      </div>
    );
  }
  if (item.component === 'spacer') return <span aria-hidden className={styles.spacer} />;
  if (item.component === 'button') {
    const operation = item.trigger
      ? app.operations.find(candidate => candidate.name === item.trigger)
      : undefined;
    const runnable = operation
      ? isOperationRunnable(operation.requiredInputs, values)
      : false;
    return (
      <button
        className={item.emphasis === 'secondary' ? styles.secondaryButton : styles.primaryButton}
        disabled={busy || !ready || !item.trigger || !runnable}
        onClick={() => item.trigger && onOperation(item.trigger)}
        type="button"
      >
        {item.label}
      </button>
    );
  }
  if (!item.bind || !item.label) return null;
  const fieldLabel = (
    <span className={item.showLabel === false ? styles.visuallyHidden : styles.label}>{item.label}</span>
  );
  if (item.component === 'select') {
    return (
      <label className={styles.field}>
        {fieldLabel}
        <select disabled={!ready} onChange={event => onChange(item.bind!, event.target.value)} value={value}>
          {item.options?.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    );
  }
  if (item.component === 'textarea') {
    const inputId = `skillapp-${item.bind}-${path}`;
    return (
      <div className={styles.field}>
        <span className={styles.fieldHeader}>
          <label className={item.showLabel === false ? styles.visuallyHidden : styles.label} htmlFor={inputId}>
            {item.label}
          </label>
          {item.copyable ? (
            <button
              className={styles.copyButton}
              onClick={() => void navigator.clipboard?.writeText(value)}
              type="button"
            >
              Copy
            </button>
          ) : null}
        </span>
        <textarea
          id={inputId}
          disabled={!ready}
          onChange={event => onChange(item.bind!, event.target.value)}
          placeholder={item.placeholder}
          readOnly={item.editable === false}
          value={value}
        />
      </div>
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

function initialValues(app: SkillAppDefinition): Record<string, string> {
  return Object.fromEntries(app.states.map(state => [state.name, state.initial]));
}

function isOperationRunnable(requiredInputs: string[], values: Record<string, string>): boolean {
  return requiredInputs.every(name => (values[name] ?? '').trim().length > 0);
}

function humanize(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : 'Operation';
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatActivityTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
