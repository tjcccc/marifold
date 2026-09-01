import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import {
  createSkillAppInstance,
  deleteSkillAppInstance,
  runSkillAppOperation,
  updateSkillAppAttachments,
  updateSkillAppState,
} from '../../api/apps';
import type {
  AgentUsage,
  SkillAppAttachmentInput,
  SkillAppDefinition,
  SkillAppLayoutItem,
  SkillAppMutationResult,
} from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { fileToBase64, prepareFiles } from '../../lib/attachments';
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
  const [attachments, setAttachments] = useState<Record<string, PreparedAttachment[]>>({});
  const [staleOutputs, setStaleOutputs] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [runningOperation, setRunningOperation] = useState<string>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const instanceRef = useRef<string | undefined>(undefined);
  const valuesRef = useRef<Record<string, string>>(app ? initialValues(app) : {});
  const attachmentsRef = useRef<Record<string, PreparedAttachment[]>>({});
  const staleOutputsRef = useRef<Set<string>>(new Set());
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
    attachmentsRef.current = {};
    staleOutputsRef.current = new Set();
    setValues(initial);
    setAttachments({});
    setStaleOutputs(new Set());
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
        staleOutputsRef.current = new Set(instance.staleOutputs ?? []);
        setValues(instance.state);
        setStaleOutputs(new Set(instance.staleOutputs ?? []));
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
    const nextStaleOutputs = new Set(staleOutputsRef.current);
    for (const operation of app.operations.filter(candidate => operationInputStates(candidate).includes(name))) {
      if ((nextValues[operation.output] ?? '').trim()) nextStaleOutputs.add(operation.output);
    }
    valuesRef.current = nextValues;
    staleOutputsRef.current = nextStaleOutputs;
    setValues(nextValues);
    setStaleOutputs(nextStaleOutputs);
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

  async function addAttachments(stateName: string, files: File[]): Promise<void> {
    if (!app || files.length === 0) return;
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    try {
      const previous = attachmentsRef.current[stateName] ?? [];
      const prepared = await prepareFiles(files, previous);
      if (prepared.rejected.length > 0) {
        appendActivity(
          'warning',
          prepared.accepted.length > 0 ? 'Some attachments were not added' : 'Attachments were not added',
          prepared.rejected.join('\n'),
        );
        setActivityOpen(true);
      }
      if (prepared.accepted.length === 0) return;
      await persistAttachments(stateName, [...previous, ...prepared.accepted], previous);
    } catch (reason) {
      appendActivity('error', 'Could not attach files', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      if (epoch === appEpoch.current) setPending(current => Math.max(0, current - 1));
    }
  }

  async function removeAttachment(stateName: string, index: number): Promise<void> {
    const previous = attachmentsRef.current[stateName] ?? [];
    if (index < 0 || index >= previous.length) return;
    const next = previous.filter((_, candidate) => candidate !== index);
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    try {
      await persistAttachments(stateName, next, previous);
    } finally {
      if (epoch === appEpoch.current) setPending(current => Math.max(0, current - 1));
    }
  }

  async function persistAttachments(
    stateName: string,
    next: PreparedAttachment[],
    previous: PreparedAttachment[],
  ): Promise<void> {
    const instanceId = instanceRef.current;
    if (!app || !instanceId) return;
    const nextByState = { ...attachmentsRef.current, [stateName]: next };
    const previousStaleOutputs = staleOutputsRef.current;
    attachmentsRef.current = nextByState;
    setAttachments(nextByState);
    const optimisticValues = { ...valuesRef.current };
    const nextStaleOutputs = new Set(staleOutputsRef.current);
    for (const operation of app.operations.filter(candidate => candidate.attachments === stateName)) {
      if ((optimisticValues[operation.output] ?? '').trim()) nextStaleOutputs.add(operation.output);
    }
    valuesRef.current = optimisticValues;
    staleOutputsRef.current = nextStaleOutputs;
    setValues(optimisticValues);
    setStaleOutputs(nextStaleOutputs);

    const version = ++mutationVersion.current;
    try {
      const result = await updateSkillAppAttachments(
        client,
        instanceId,
        stateName,
        await attachmentInputs(next),
      );
      applyMutation(result, version);
    } catch (reason) {
      if (version === mutationVersion.current) {
        const restored = { ...attachmentsRef.current, [stateName]: previous };
        attachmentsRef.current = restored;
        staleOutputsRef.current = previousStaleOutputs;
        setAttachments(restored);
        setStaleOutputs(previousStaleOutputs);
      }
      handleError(reason, version, 'Could not update attachments');
    }
  }

  function applyMutation(result: SkillAppMutationResult, version: number): void {
    if (version !== mutationVersion.current || result.status === 'superseded') return;
    valuesRef.current = result.instance.state;
    staleOutputsRef.current = new Set(result.instance.staleOutputs ?? []);
    setValues(result.instance.state);
    setStaleOutputs(new Set(result.instance.staleOutputs ?? []));
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
              attachments={attachments}
              onAttachFiles={(name, files) => void addAttachments(name, files)}
              onChange={setValue}
              onRemoveAttachment={(name, index) => void removeAttachment(name, index)}
              path={String(index)}
              ready={instanceRef.current !== undefined}
              staleOutputs={staleOutputs}
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
  attachments,
  busy,
  item,
  onAttachFiles,
  onOperation,
  onChange,
  onRemoveAttachment,
  path,
  ready,
  staleOutputs,
  values,
}: {
  app: SkillAppDefinition;
  attachments: Record<string, PreparedAttachment[]>;
  busy: boolean;
  item: SkillAppLayoutItem;
  onAttachFiles: (name: string, files: File[]) => void;
  onOperation: (name: string) => void;
  onChange: (name: string, value: string) => void;
  onRemoveAttachment: (name: string, index: number) => void;
  path: string;
  ready: boolean;
  staleOutputs: Set<string>;
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
              {...{
                app,
                attachments,
                busy,
                item: child,
                onAttachFiles,
                onOperation,
                onChange,
                onRemoveAttachment,
                ready,
                staleOutputs,
                values,
              }}
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
    const button = (
      <button
        className={item.emphasis === 'secondary' ? styles.secondaryButton : styles.primaryButton}
        disabled={busy || !ready || !item.trigger || !runnable}
        onClick={() => item.trigger && onOperation(item.trigger)}
        type="button"
      >
        {item.label}
      </button>
    );
    return item.alignToField ? (
      <div className={styles.fieldAlignedButton}>
        <span aria-hidden className={styles.fieldLabelSpacer} />
        {button}
      </div>
    ) : button;
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
          {item.options?.map(option => {
            const choice = typeof option === 'string' ? { label: option, value: option } : option;
            return <option key={choice.value} value={choice.value}>{choice.label}</option>;
          })}
        </select>
      </label>
    );
  }
  if (item.component === 'textarea') {
    return (
      <SkillTextarea
        {...{ item, onChange, path, ready, value }}
        stale={staleOutputs.has(item.bind) && Boolean(value.trim())}
      />
    );
  }
  if (item.component === 'attachments') {
    return (
      <SkillAttachments
        attachments={attachments[item.bind] ?? []}
        busy={busy || !ready}
        item={item}
        onAttachFiles={files => onAttachFiles(item.bind!, files)}
        onRemove={index => onRemoveAttachment(item.bind!, index)}
        path={path}
      />
    );
  }
  return null;
}

function SkillAttachments({
  attachments,
  busy,
  item,
  onAttachFiles,
  onRemove,
  path,
}: {
  attachments: PreparedAttachment[];
  busy: boolean;
  item: SkillAppLayoutItem;
  onAttachFiles: (files: File[]) => void;
  onRemove: (index: number) => void;
  path: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputId = `skillapp-${item.bind}-${path}`;

  function acceptFiles(files: FileList | File[]): void {
    if (!busy && files.length > 0) onAttachFiles([...files]);
  }

  return (
    <div className={styles.field}>
      <label className={item.showLabel === false ? styles.visuallyHidden : styles.label} htmlFor={inputId}>
        {item.label}
      </label>
      <div
        className={`${styles.attachmentZone} ${dragActive ? styles.attachmentZoneActive : ''}`}
        onDragEnter={event => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDragOver={event => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={event => {
          event.preventDefault();
          setDragActive(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <button
          aria-label={attachments.length > 0 ? 'Add more attachments' : 'Choose attachments'}
          className={styles.attachmentPicker}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          {attachments.length === 0 ? (
            <span><strong>Choose files</strong> or drop them here</span>
          ) : null}
        </button>
        <input
          className={styles.fileInput}
          id={inputId}
          multiple
          onChange={event => {
            acceptFiles(event.target.files ?? []);
            event.target.value = '';
          }}
          ref={inputRef}
          type="file"
        />
        {attachments.length > 0 ? (
          <div className={styles.attachmentChips}>
            {attachments.map((attachment, index) => (
              <span className={styles.attachmentChip} key={`${attachment.name}-${index}`} title={attachment.name}>
                {attachment.kind === 'image' ? (
                  <img
                    alt=""
                    className={styles.attachmentThumbnail}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  />
                ) : (
                  <span aria-hidden className={styles.attachmentFileIcon}>▤</span>
                )}
                <span className={styles.attachmentName}>{attachment.name}</span>
                <button
                  aria-label={`Remove ${attachment.name}`}
                  className={styles.attachmentRemove}
                  disabled={busy}
                  onClick={() => onRemove(index)}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SkillTextarea({
  item,
  onChange,
  path,
  ready,
  stale,
  value,
}: {
  item: SkillAppLayoutItem;
  onChange: (name: string, value: string) => void;
  path: string;
  ready: boolean;
  stale: boolean;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = `skillapp-${item.bind}-${path}`;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !item.autoGrow) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }, [item.autoGrow, value]);

  return (
    <div className={styles.field}>
      <span className={styles.fieldHeader}>
        <label className={item.showLabel === false ? styles.visuallyHidden : styles.label} htmlFor={inputId}>
          {item.label}
        </label>
        <span className={styles.fieldHeaderActions}>
          {stale ? (
            <span aria-label="Based on previous inputs" className={styles.staleHint} role="status">
              Based on previous inputs
            </span>
          ) : null}
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
      </span>
      <textarea
        className={`${item.rows ? styles.sizedTextarea : ''} ${item.autoGrow ? styles.autoGrowTextarea : ''}`}
        id={inputId}
        disabled={!ready}
        onChange={event => item.bind && onChange(item.bind, event.target.value)}
        placeholder={item.placeholder}
        readOnly={item.editable === false}
        ref={textareaRef}
        rows={item.rows}
        value={value}
      />
    </div>
  );
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

async function attachmentInputs(attachments: PreparedAttachment[]): Promise<SkillAppAttachmentInput[]> {
  return Promise.all(attachments.map(async attachment => {
    if (attachment.kind === 'image') {
      return {
        kind: 'image' as const,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        data: attachment.data,
      };
    }
    if (attachment.kind === 'file') {
      return {
        kind: 'file' as const,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        data: await fileToBase64(attachment.originalFile),
      };
    }
    const source = attachment.originalFile
      ?? new Blob([attachment.content], { type: attachment.mediaType || 'text/plain' });
    return {
      kind: 'file' as const,
      name: attachment.name,
      mediaType: attachment.mediaType || source.type || 'text/plain',
      size: source.size,
      data: await fileToBase64(source),
      inspectionText: attachment.content,
    };
  }));
}

function isOperationRunnable(requiredInputs: string[], values: Record<string, string>): boolean {
  return requiredInputs.every(name => (values[name] ?? '').trim().length > 0);
}

function operationInputStates(operation: SkillAppDefinition['operations'][number]): string[] {
  return [...new Set([
    ...(operation.skillState ? [operation.skillState] : []),
    ...(operation.input ? [operation.input] : []),
    ...operation.requiredInputs,
    ...Object.values(operation.parameters),
  ])];
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
