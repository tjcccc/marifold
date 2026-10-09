import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { answerSkillAppApproval, answerSkillAppInput, cancelSkillAppExecution, createSkillAppInstance, deleteSkillAppInstance, getSkillAppInstance, runSkillAppOperation, updateSkillAppAttachments, updateSkillAppState } from '../../api/apps';
import type { SkillAppDefinition, SkillAppExecutionSnapshot, SkillAppInstanceSnapshot, SkillAppMutationResult, UserInputSubmission } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { prepareFiles } from '../../lib/attachments';
import { ApprovalSheet } from '../agent/ApprovalSheet';
import { QuestionSheet } from '../agent/QuestionSheet';
import styles from './AppsScreen.module.css';
import { SkillLayoutItem } from './SkillAppLayout';
import { attachmentInputs, errorMessage, executionStatus, formatActivityTime, formatMetrics, humanize, initialValues, isExecutionActive, isOperationRunnable, openSkillAppInstance, operationInputStates, type RunMetrics, skillAppInstanceStorageKey, storeInstance } from './skillAppHelpers';

export interface AppsScreenProps {
  client: ApiClient;
  onUnauthorized: () => void;
  app?: SkillAppDefinition;
  loading?: boolean;
  loadError?: string;
  onBusyChange?: (busy: boolean) => void;
  onAppInstalled?: () => void | Promise<void>;
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
  onAppInstalled,
}: AppsScreenProps) {
  const [values, setValues] = useState<Record<string, string>>(() => app ? initialValues(app) : {});
  const [attachments, setAttachments] = useState<Record<string, PreparedAttachment[]>>({});
  const [staleOutputs, setStaleOutputs] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [runningOperation, setRunningOperation] = useState<string>();
  const [execution, setExecution] = useState<SkillAppExecutionSnapshot>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const instanceRef = useRef<string | undefined>(undefined);
  const valuesRef = useRef<Record<string, string>>(app ? initialValues(app) : {});
  const attachmentsRef = useRef<Record<string, PreparedAttachment[]>>({});
  const staleOutputsRef = useRef<Set<string>>(new Set());
  const mutationVersion = useRef(0);
  const appEpoch = useRef(0);
  const activityId = useRef(0);
  const handledExecutions = useRef(new Set<string>());

  useEffect(() => {
    const epoch = ++appEpoch.current;
    let live = true;
    let openedId: string | undefined;
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
    setExecution(undefined);
    handledExecutions.current.clear();

    if (!app) {
      setPending(0);
      return () => {
        live = false;
      };
    }

    const storageKey = skillAppInstanceStorageKey(client, app.app.name);
    setPending(1);
    void openSkillAppInstance(client, app.app.name, storageKey)
      .then(instance => {
        openedId = instance.id;
        if (!live) {
          storeInstance(storageKey, instance.id);
          return;
        }
        instanceRef.current = instance.id;
        applyInstanceSnapshot(instance);
      })
      .catch(reason => {
        if (!live) { return; }
        if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
        appendActivity('error', 'Could not open app', errorMessage(reason));
        setActivityOpen(true);
      })
      .finally(() => {
        if (live && epoch === appEpoch.current) { setPending(0); }
      });
    return () => {
      live = false;
      if (appEpoch.current === epoch) { appEpoch.current += 1; }
      mutationVersion.current += 1;
      instanceRef.current = undefined;
      if (openedId) { storeInstance(storageKey, openedId); }
    };
  }, [app, client, onUnauthorized]);

  const executionActive = isExecutionActive(execution);
  const interfaceBusy = pending > 0 || executionActive;

  useEffect(() => {
    onBusyChange(interfaceBusy);
    return () => onBusyChange(false);
  }, [interfaceBusy, onBusyChange]);

  useEffect(() => {
    if (!activityOpen) { return; }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setActivityOpen(false); }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [activityOpen]);

  useEffect(() => {
    const instanceId = instanceRef.current;
    if (!instanceId || !executionActive || !execution) { return; }
    let live = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await getSkillAppInstance(client, instanceId);
        if (!live) { return; }
        applyInstanceSnapshot(snapshot);
        if (isExecutionActive(snapshot.execution)) {
          timer = window.setTimeout(() => void poll(), 400);
        }
      } catch (reason) {
        if (!live) { return; }
        if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
        appendActivity('error', 'Could not follow App operation', errorMessage(reason));
        setActivityOpen(true);
      }
    };
    timer = window.setTimeout(() => void poll(), 250);
    return () => {
      live = false;
      if (timer !== undefined) { window.clearTimeout(timer); }
    };
  }, [client, execution?.id, execution?.phase, executionActive, onUnauthorized]);

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

  function applyInstanceSnapshot(snapshot: SkillAppInstanceSnapshot): void {
    valuesRef.current = snapshot.state;
    staleOutputsRef.current = new Set(snapshot.staleOutputs ?? []);
    setValues(snapshot.state);
    setStaleOutputs(new Set(snapshot.staleOutputs ?? []));
    setExecution(snapshot.execution);
    if (app) {
      const storageKey = skillAppInstanceStorageKey(client, app.app.name);
      storeInstance(storageKey, snapshot.id);
    }
    const terminal = snapshot.execution;
    if (!terminal || isExecutionActive(terminal) || handledExecutions.current.has(terminal.id)) { return; }
    handledExecutions.current.add(terminal.id);
    setRunningOperation(undefined);
    const label = humanize(terminal.operation);
    if (terminal.phase === 'cancelled') {
      appendActivity('warning', `${label} cancelled`);
      return;
    }
    if (terminal.result?.status === 'error' || terminal.phase === 'failed') {
      appendActivity(
        'error',
        `${label} failed`,
        terminal.result?.status === 'error' ? terminal.result.error.message : 'The operation failed.',
      );
      setActivityOpen(true);
      return;
    }
    if (terminal.result?.status === 'ok') {
      appendActivity('success', `${label} completed`, undefined, {
        latencyMs: terminal.result.meta.durationMs,
        ...(terminal.result.meta.usage?.totalTokens !== undefined
          ? { usage: { totalTokens: terminal.result.meta.usage.totalTokens } }
          : {}),
      });
      for (const effect of terminal.result.effects ?? []) {
        if (effect.kind === 'app_installed') {
          appendActivity(
            'success',
            `${effect.title} ${effect.action}`,
            `${effect.files.length} validated ${effect.files.length === 1 ? 'file' : 'files'} · no service restart required`,
          );
          void onAppInstalled?.();
        }
      }
    }
  }

  function setValue(name: string, value: string): void {
    if (!app) { return; }
    const nextValues = { ...valuesRef.current, [name]: value };
    const nextStaleOutputs = new Set(staleOutputsRef.current);
    for (const operation of app.operations.filter(candidate => operationInputStates(candidate).includes(name))) {
      if ((nextValues[operation.output] ?? '').trim()) { nextStaleOutputs.add(operation.output); }
    }
    valuesRef.current = nextValues;
    staleOutputsRef.current = nextStaleOutputs;
    setValues(nextValues);
    setStaleOutputs(nextStaleOutputs);
    setRunningOperation(undefined);

    const instanceId = instanceRef.current;
    if (!instanceId) { return; }
    const version = ++mutationVersion.current;
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    void updateSkillAppState(client, instanceId, { [name]: value })
      .then(result => applyMutation(result, version))
      .catch(reason => handleError(reason, version, 'Could not update app'))
      .finally(() => {
        if (epoch === appEpoch.current) { setPending(current => Math.max(0, current - 1)); }
      });
  }

  function run(operationName: string): void {
    if (!app) { return; }
    const operation = app.operations.find(candidate => candidate.name === operationName);
    const instanceId = instanceRef.current;
    if (!operation || !instanceId || !isOperationRunnable(operation.requiredInputs, valuesRef.current)) { return; }

    const version = ++mutationVersion.current;
    const epoch = appEpoch.current;
    const label = humanize(operationName);
    const nextValues = { ...valuesRef.current, [operation.output]: '' };
    const nextStaleOutputs = new Set(staleOutputsRef.current);
    nextStaleOutputs.delete(operation.output);
    valuesRef.current = nextValues;
    staleOutputsRef.current = nextStaleOutputs;
    setValues(nextValues);
    setStaleOutputs(nextStaleOutputs);
    setPending(current => current + 1);
    setRunningOperation(operationName);
    appendActivity('info', `${label} started`);
    void runSkillAppOperation(client, instanceId, operationName)
      .then(result => applyMutation(result, version))
      .catch(reason => handleError(reason, version, `${label} failed`))
      .finally(() => {
        if (epoch === appEpoch.current) { setPending(current => Math.max(0, current - 1)); }
        if (!operation.interactive && version === mutationVersion.current) { setRunningOperation(undefined); }
      });
  }

  async function submitExecutionInput(submission: UserInputSubmission): Promise<void> {
    const instanceId = instanceRef.current;
    if (!instanceId || !execution?.userInput) { return; }
    setPending(current => current + 1);
    try {
      applyInstanceSnapshot(await answerSkillAppInput(client, instanceId, execution.id, submission));
    } catch (reason) {
      appendActivity('error', 'Could not submit answers', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      setPending(current => Math.max(0, current - 1));
    }
  }

  async function answerExecutionApproval(action: 'once' | 'deny'): Promise<void> {
    const instanceId = instanceRef.current;
    if (!instanceId || !execution?.approval) { return; }
    setPending(current => current + 1);
    try {
      applyInstanceSnapshot(await answerSkillAppApproval(client, instanceId, execution.id, action));
    } catch (reason) {
      appendActivity('error', 'Could not submit approval', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      setPending(current => Math.max(0, current - 1));
    }
  }

  async function cancelExecution(): Promise<void> {
    const instanceId = instanceRef.current;
    if (!instanceId || !execution || !isExecutionActive(execution)) { return; }
    setPending(current => current + 1);
    try {
      applyInstanceSnapshot(await cancelSkillAppExecution(client, instanceId, execution.id));
    } catch (reason) {
      appendActivity('error', 'Could not cancel operation', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      setPending(current => Math.max(0, current - 1));
    }
  }

  async function resetApp(): Promise<void> {
    if (!app || interfaceBusy) { return; }
    const previousId = instanceRef.current;
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    try {
      const fresh = await createSkillAppInstance(client, app.app.name);
      if (epoch !== appEpoch.current) {
        storeInstance(skillAppInstanceStorageKey(client, app.app.name), fresh.id);
        return;
      }
      instanceRef.current = fresh.id;
      attachmentsRef.current = {};
      setAttachments({});
      handledExecutions.current.clear();
      setRunningOperation(undefined);
      setActivity([]);
      setActivityOpen(false);
      applyInstanceSnapshot(fresh);
      if (previousId && previousId !== fresh.id) {
        void deleteSkillAppInstance(client, previousId).catch(() => {});
      }
    } catch (reason) {
      if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
      appendActivity('error', 'Could not reset app', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      if (epoch === appEpoch.current) { setPending(current => Math.max(0, current - 1)); }
    }
  }

  async function addAttachments(stateName: string, files: File[]): Promise<void> {
    if (!app || files.length === 0) { return; }
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
      if (prepared.accepted.length === 0) { return; }
      await persistAttachments(stateName, [...previous, ...prepared.accepted], previous);
    } catch (reason) {
      appendActivity('error', 'Could not attach files', errorMessage(reason));
      setActivityOpen(true);
    } finally {
      if (epoch === appEpoch.current) { setPending(current => Math.max(0, current - 1)); }
    }
  }

  async function removeAttachment(stateName: string, index: number): Promise<void> {
    const previous = attachmentsRef.current[stateName] ?? [];
    if (index < 0 || index >= previous.length) { return; }
    const next = previous.filter((_, candidate) => candidate !== index);
    const epoch = appEpoch.current;
    setPending(current => current + 1);
    try {
      await persistAttachments(stateName, next, previous);
    } finally {
      if (epoch === appEpoch.current) { setPending(current => Math.max(0, current - 1)); }
    }
  }

  async function persistAttachments(
    stateName: string,
    next: PreparedAttachment[],
    previous: PreparedAttachment[],
  ): Promise<void> {
    const instanceId = instanceRef.current;
    if (!app || !instanceId) { return; }
    const nextByState = { ...attachmentsRef.current, [stateName]: next };
    const previousStaleOutputs = staleOutputsRef.current;
    attachmentsRef.current = nextByState;
    setAttachments(nextByState);
    const optimisticValues = { ...valuesRef.current };
    const nextStaleOutputs = new Set(staleOutputsRef.current);
    for (const operation of app.operations.filter(candidate => candidate.attachments === stateName)) {
      if ((optimisticValues[operation.output] ?? '').trim()) { nextStaleOutputs.add(operation.output); }
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
    if (version !== mutationVersion.current || result.status === 'superseded') { return; }
    applyInstanceSnapshot(result.instance);
    if (result.reason === 'missing_required_input') { return; }
    if (result.status === 'running') { return; }

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
    if (version !== mutationVersion.current) { return; }
    if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
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
  const runningOutput = runningOperation
    ? app.operations.find(operation => operation.name === runningOperation)?.output
    : undefined;
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
              busy={interfaceBusy}
              item={item}
              key={`${item.component}-${index}`}
              locked={executionActive}
              onOperation={run}
              attachments={attachments}
              onAttachFiles={(name, files) => void addAttachments(name, files)}
              onChange={setValue}
              onRemoveAttachment={(name, index) => void removeAttachment(name, index)}
              path={String(index)}
              ready={instanceRef.current !== undefined}
              runningOutput={runningOutput}
              staleOutputs={staleOutputs}
              values={values}
            />
          ))}
          {executionActive && execution ? (
            <section className={styles.executionPanel} aria-label="Interactive App operation">
              <div className={styles.executionStatus} role="status">
                <span className={styles.executionSpinner} aria-hidden />
                <span>{executionStatus(execution)}</span>
                <button
                  className={styles.executionCancel}
                  disabled={pending > 0}
                  onClick={() => void cancelExecution()}
                  type="button"
                >
                  Cancel
                </button>
              </div>
              {execution.approval ? (
                <ApprovalSheet
                  request={execution.approval}
                  busy={pending > 0}
                  onAnswer={action => {
                    if (action === 'once' || action === 'deny') { void answerExecutionApproval(action); }
                  }}
                />
              ) : null}
              {execution.userInput ? (
                <QuestionSheet
                  key={execution.userInput.id}
                  request={execution.userInput}
                  busy={pending > 0}
                  onSubmit={submission => void submitExecutionInput(submission)}
                />
              ) : null}
            </section>
          ) : null}
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
          {interfaceBusy ? (
            <span className={styles.footerStatus} role="status">
              {executionActive && execution
                ? executionStatus(execution)
                : runningOperation ? `Running ${humanize(runningOperation)}…` : 'Updating…'}
            </span>
          ) : null}
          <button
            className={styles.footerButton}
            disabled={interfaceBusy || instanceRef.current === undefined}
            onClick={() => void resetApp()}
            type="button"
          >
            Reset
          </button>
          <button
            aria-controls="skillapp-activity"
            aria-expanded={activityOpen}
            className={`${styles.footerButton} ${hasErrors ? styles.activityButtonError : ''}`}
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

function WorkspaceEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.placeholder}>
      <div className={styles.placeholderTitle}>{title}</div>
      <div className={styles.placeholderHint}>{detail}</div>
    </div>
  );
}
