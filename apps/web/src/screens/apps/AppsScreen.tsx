import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { answerSkillAppApproval, answerSkillAppInput, cancelSkillAppExecution, createSkillAppInstance, deleteSkillAppInstance, getSkillAppInstance, startSkillAppExecution, updateSkillAppAttachments, updateSkillAppState } from '../../api/apps';
import type { SkillAppDefinition, SkillAppExecutionSnapshot, SkillAppInstanceSnapshot, SkillAppInvalidEntry, SkillAppMutationResult, SkillAppResult, UserInputSubmission } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { prepareFiles } from '../../lib/attachments';
import { ApprovalSheet } from '../agent/ApprovalSheet';
import { QuestionSheet } from '../agent/QuestionSheet';
import styles from './AppsScreen.module.css';
import { type ActivityEntry, type ActivityTone, SkillAppActivityDrawer } from './SkillAppActivity';
import { SkillLayoutItem } from './SkillAppLayout';
import { attachmentInputs, editableValues, errorMessage, executionStatus, humanize, initialValues, isExecutionActive, isOperationRunnable, openSkillAppInstance, operationInputStates, type RunMetrics, skillAppInstanceStorageKey, storeInstance, triggeredOperations } from './skillAppHelpers';

export interface AppsScreenProps {
  client: ApiClient;
  onUnauthorized: () => void;
  app?: SkillAppDefinition;
  /** The selected bundle failed to load; shown with its exact error. */
  invalidApp?: SkillAppInvalidEntry;
  loading?: boolean;
  loadError?: string;
  onBusyChange?: (busy: boolean) => void;
  onAppInstalled?: () => void | Promise<void>;
}

/** Field edits are coalesced briefly before they reach the service. */
const STATE_SYNC_DEBOUNCE_MS = 150;

const ignoreBusyChange = () => {};

export function AppsScreen({
  client,
  onUnauthorized,
  app,
  invalidApp,
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
  const [triggeredRuns, setTriggeredRuns] = useState<string[]>([]);
  const [outputErrors, setOutputErrors] = useState<Record<string, string>>({});
  const [execution, setExecution] = useState<SkillAppExecutionSnapshot>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const instanceRef = useRef<string | undefined>(undefined);
  const valuesRef = useRef<Record<string, string>>(app ? initialValues(app) : {});
  // Last state the service acknowledged; a run start sends only differences.
  const serverValuesRef = useRef<Record<string, string>>({});
  const attachmentsRef = useRef<Record<string, PreparedAttachment[]>>({});
  const staleOutputsRef = useRef<Set<string>>(new Set());
  const mutationVersion = useRef(0);
  const appEpoch = useRef(0);
  const activityId = useRef(0);
  const handledExecutions = useRef(new Set<string>());
  // Debounced field edits not yet sent. State sync never marks the App busy:
  // a run carries the latest values itself, so it never reads stale input.
  const pendingSync = useRef<Record<string, string>>({});
  const syncTimer = useRef<number | undefined>(undefined);
  const triggerSyncVersion = useRef(0);

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
    setTriggeredRuns([]);
    setOutputErrors({});
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
      // Deliver edits still waiting for the debounce; the instance outlives
      // this view and reopens from session storage.
      const unsent = pendingSync.current;
      pendingSync.current = {};
      if (syncTimer.current !== undefined) { window.clearTimeout(syncTimer.current); }
      syncTimer.current = undefined;
      if (instanceRef.current && Object.keys(unsent).length > 0) {
        void updateSkillAppState(client, instanceRef.current, unsent).catch(() => {});
      }
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

  function setOutputError(operationName: string | undefined, message?: string): void {
    const output = app?.operations.find(operation => operation.name === operationName)?.output;
    if (!output) { return; }
    setOutputErrors(current => {
      if (message === undefined && !(output in current)) { return current; }
      const next = { ...current };
      if (message === undefined) { delete next[output]; }
      else { next[output] = message; }
      return next;
    });
  }

  /** Record a finished run in Activity and inline next to its output. */
  function reportResult(operationName: string, result: SkillAppResult): void {
    const label = humanize(operationName);
    if (result.status === 'error') {
      setOutputError(operationName, result.error.message);
      appendActivity('error', `${label} failed`, result.error.message);
      setActivityOpen(true);
      return;
    }
    setOutputError(operationName);
    appendActivity('success', `${label} completed`, undefined, {
      latencyMs: result.meta.durationMs,
      ...(result.meta.usage?.totalTokens !== undefined
        ? { usage: { totalTokens: result.meta.usage.totalTokens } }
        : {}),
    });
    for (const effect of result.effects ?? []) {
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

  function applyInstanceSnapshot(snapshot: SkillAppInstanceSnapshot): void {
    valuesRef.current = snapshot.state;
    serverValuesRef.current = snapshot.state;
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
    if (terminal.phase === 'cancelled') {
      setOutputError(terminal.operation);
      appendActivity('warning', `${humanize(terminal.operation)} cancelled`);
      return;
    }
    reportResult(terminal.operation, terminal.result ?? {
      status: 'error',
      error: { code: 'APP_FAILED', message: 'The operation failed.' },
    });
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

    // Every keystroke invalidates older responses so they cannot overwrite
    // text typed while a request was in flight.
    mutationVersion.current += 1;
    pendingSync.current = { ...pendingSync.current, [name]: value };
    if (syncTimer.current !== undefined) { window.clearTimeout(syncTimer.current); }
    syncTimer.current = window.setTimeout(flushStateSync, STATE_SYNC_DEBOUNCE_MS);
  }

  function flushStateSync(): void {
    syncTimer.current = undefined;
    const changes = pendingSync.current;
    pendingSync.current = {};
    const instanceId = instanceRef.current;
    if (!app || !instanceId || Object.keys(changes).length === 0) { return; }
    const version = mutationVersion.current;
    const triggered = triggeredOperations(app, Object.keys(changes), valuesRef.current);
    if (triggered.length > 0) {
      triggerSyncVersion.current = version;
      setTriggeredRuns(triggered);
    }
    void updateSkillAppState(client, instanceId, changes)
      .then(result => applyMutation(result, version))
      .catch(reason => handleError(reason, version, 'Could not update app'))
      .finally(() => {
        if (triggered.length > 0 && triggerSyncVersion.current === version) { setTriggeredRuns([]); }
      });
  }

  function run(operationName: string): void {
    if (!app) { return; }
    const operation = app.operations.find(candidate => candidate.name === operationName);
    const instanceId = instanceRef.current;
    if (!operation || !instanceId || !isOperationRunnable(operation.requiredInputs, valuesRef.current)) { return; }

    // The start request carries every editable value the service has not
    // acknowledged, so pending debounced edits are folded in rather than sent
    // separately. Fields lock from the click until the execution resolves.
    if (syncTimer.current !== undefined) { window.clearTimeout(syncTimer.current); }
    syncTimer.current = undefined;
    pendingSync.current = {};
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
    setOutputError(operationName);
    setPending(current => current + 1);
    setRunningOperation(operationName);
    appendActivity('info', `${label} started`);
    const unacknowledged = Object.fromEntries(Object.entries(editableValues(app, nextValues))
      .filter(([name, value]) => serverValuesRef.current[name] !== value));
    void startSkillAppExecution(client, instanceId, operationName, unacknowledged)
      .then(result => {
        if (epoch !== appEpoch.current) { return; }
        // A started execution is authoritative even if the version moved on.
        if (result.instance.execution && isExecutionActive(result.instance.execution)) {
          applyInstanceSnapshot(result.instance);
          return;
        }
        applyMutation(result, version);
      })
      .catch(reason => {
        if (version === mutationVersion.current) { setOutputError(operationName, errorMessage(reason)); }
        handleError(reason, version, `${label} failed`);
      })
      .finally(() => {
        if (epoch === appEpoch.current) {
          setPending(current => Math.max(0, current - 1));
          setRunningOperation(undefined);
        }
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
    // Drop unsent edits and make in-flight responses for the old instance stale.
    if (syncTimer.current !== undefined) { window.clearTimeout(syncTimer.current); }
    syncTimer.current = undefined;
    pendingSync.current = {};
    mutationVersion.current += 1;
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
      setTriggeredRuns([]);
      setOutputErrors({});
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
    if (result.reason === 'missing_required_input' || result.status === 'running') { return; }
    // Automatic trigger results arrive here; button runs report via execution.
    if (result.result && result.operation) { reportResult(result.operation, result.result); }
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
        {invalidApp ? (
          <div className={styles.placeholder} role="alert">
            <div className={styles.placeholderTitle}>Cannot load {invalidApp.name}</div>
            <div className={styles.invalidAppMessage}>{invalidApp.message}</div>
            <div className={styles.placeholderHint}>{invalidApp.code} · fix the bundle and the catalog refreshes automatically.</div>
          </div>
        ) : (
          <WorkspaceEmptyState
            title={loadError ? 'Could not load apps' : 'No Apps yet'}
            detail={loadError ?? 'Add an <app-name>/skillapp.ts bundle to ~/.marifold/apps.'}
          />
        )}
      </main>
    );
  }

  const hasErrors = activity.some(entry => entry.tone === 'error');
  const activeOperation = executionActive && execution ? execution.operation : runningOperation;
  const runningOutputs = new Set(app.operations
    .filter(operation => operation.name === activeOperation || triggeredRuns.includes(operation.name))
    .map(operation => operation.output));
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
              locked={executionActive || runningOperation !== undefined}
              onOperation={run}
              attachments={attachments}
              onAttachFiles={(name, files) => void addAttachments(name, files)}
              onChange={setValue}
              onRemoveAttachment={(name, index) => void removeAttachment(name, index)}
              outputErrors={outputErrors}
              path={String(index)}
              ready={instanceRef.current !== undefined}
              runningOutputs={runningOutputs}
              staleOutputs={staleOutputs}
              values={values}
            />
          ))}
          {executionActive && execution ? (
            <section className={styles.executionPanel} aria-label="App operation">
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
        <SkillAppActivityDrawer
          activity={activity}
          onClear={() => setActivity([])}
          onClose={() => setActivityOpen(false)}
        />
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
