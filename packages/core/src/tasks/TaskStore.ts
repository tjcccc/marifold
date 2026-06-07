import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';

export const TASK_STATE_SCHEMA = 'marifold.task-state.v1';

export type TaskStatus = 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'cancelled';
export type TaskEventKind = 'progress' | 'decision' | 'observation' | 'blocker' | 'verification' | 'note';

export interface TaskPlanItem {
  id: string;
  text: string;
  status: TaskStepStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  kind: TaskEventKind;
  message: string;
  createdAt: string;
  stepId?: string;
  metadata?: Record<string, string>;
}

export interface TaskState {
  schema: typeof TASK_STATE_SCHEMA;
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  profile?: string;
  sessionId?: string;
  summary?: string;
  nextAction?: string;
  tags: string[];
  plan: TaskPlanItem[];
  events: TaskEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  profile?: string;
  sessionId?: string;
  summary?: string;
  nextAction?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  planCounts: Record<TaskStepStatus, number>;
  lastEvent?: TaskEvent;
}

export interface TaskPlanInput {
  id?: string;
  text: string;
  status?: TaskStepStatus;
}

export interface TaskCreateInput {
  objective: string;
  title?: string;
  status?: TaskStatus;
  profile?: string;
  sessionId?: string;
  summary?: string;
  nextAction?: string;
  tags?: string[];
  plan?: TaskPlanInput[];
}

export interface TaskUpdateInput {
  title?: string;
  objective?: string;
  status?: TaskStatus;
  profile?: string;
  sessionId?: string;
  summary?: string;
  nextAction?: string;
  tags?: string[];
  plan?: TaskPlanInput[];
}

export interface TaskEventInput {
  kind?: TaskEventKind;
  message: string;
  stepId?: string;
  metadata?: Record<string, string>;
}

export interface TaskListOptions {
  status?: TaskStatus;
  limit?: number;
}

const SAFE_TASK_ID = /^[A-Za-z0-9_-]+$/;
const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

export class TaskStore {
  constructor(private readonly tasksDir: string) {}

  create(input: TaskCreateInput): TaskState {
    const now = new Date().toISOString();
    const objective = requiredText(input.objective, 'objective');
    const status = normalizeTaskStatus(input.status ?? 'running');
    const task: TaskState = {
      schema: TASK_STATE_SCHEMA,
      id: this.createTaskId(),
      title: optionalText(input.title) ?? titleFromObjective(objective),
      objective,
      status,
      tags: normalizeTags(input.tags),
      plan: normalizePlan(input.plan ?? [], now),
      events: [],
      createdAt: now,
      updatedAt: now,
      ...(TERMINAL_STATUSES.has(status) ? { completedAt: now } : {}),
      ...optionalField('profile', input.profile),
      ...optionalField('sessionId', input.sessionId),
      ...optionalField('summary', input.summary),
      ...optionalField('nextAction', input.nextAction),
    };
    assertPlanInvariant(task.plan);
    this.write(task);
    return task;
  }

  list(options: TaskListOptions = {}): TaskSummary[] {
    const limit = normalizeLimit(options.limit);
    const status = options.status ? normalizeTaskStatus(options.status) : undefined;
    if (!fs.existsSync(this.tasksDir)) return [];

    const tasks = fs.readdirSync(this.tasksDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => this.readFile(path.join(this.tasksDir, entry.name)))
      .filter(task => status === undefined || task.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    return tasks.map(task => this.toSummary(task));
  }

  get(taskId: string): TaskState | undefined {
    this.assertSafeTaskId(taskId);
    const taskPath = this.taskPath(taskId);
    if (!fs.existsSync(taskPath)) return undefined;
    return this.readFile(taskPath);
  }

  require(taskId: string): TaskState {
    const task = this.get(taskId);
    if (!task) throw MarifoldError.taskNotFound(taskId);
    return task;
  }

  update(taskId: string, input: TaskUpdateInput): TaskState {
    const task = this.require(taskId);
    const now = new Date().toISOString();

    if (input.title !== undefined) task.title = requiredText(input.title, 'title');
    if (input.objective !== undefined) task.objective = requiredText(input.objective, 'objective');
    if (input.status !== undefined) {
      task.status = normalizeTaskStatus(input.status);
      if (TERMINAL_STATUSES.has(task.status)) task.completedAt = now;
      else delete task.completedAt;
    }
    if (input.plan !== undefined) task.plan = normalizePlan(input.plan, now);
    assignOptional(task, 'profile', input.profile);
    assignOptional(task, 'sessionId', input.sessionId);
    assignOptional(task, 'summary', input.summary);
    assignOptional(task, 'nextAction', input.nextAction);
    if (input.tags !== undefined) task.tags = normalizeTags(input.tags);

    task.updatedAt = now;
    assertPlanInvariant(task.plan);
    this.write(task);
    return task;
  }

  appendEvent(taskId: string, input: TaskEventInput): TaskState {
    const task = this.require(taskId);
    const now = new Date().toISOString();
    const event: TaskEvent = {
      id: this.createEventId(),
      kind: normalizeEventKind(input.kind ?? 'progress'),
      message: requiredText(input.message, 'message'),
      createdAt: now,
      ...optionalField('stepId', input.stepId),
      ...(input.metadata ? { metadata: normalizeMetadata(input.metadata) } : {}),
    };
    if (event.stepId && !task.plan.some(item => item.id === event.stepId)) {
      throw MarifoldError.taskInvalid(`Task plan step not found: ${event.stepId}`, taskId);
    }
    task.events.push(event);
    task.updatedAt = now;
    this.write(task);
    return task;
  }

  delete(taskId: string): boolean {
    this.assertSafeTaskId(taskId);
    const taskPath = this.taskPath(taskId);
    if (!fs.existsSync(taskPath)) return false;
    fs.rmSync(taskPath);
    return true;
  }

  toSummary(task: TaskState): TaskSummary {
    return {
      id: task.id,
      title: task.title,
      objective: task.objective,
      status: task.status,
      tags: [...task.tags],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      planCounts: countPlan(task.plan),
      ...(task.profile ? { profile: task.profile } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
      ...(task.nextAction ? { nextAction: task.nextAction } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(task.events.length > 0 ? { lastEvent: task.events[task.events.length - 1] } : {}),
    };
  }

  private createTaskId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const id = `task_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
      if (!fs.existsSync(this.taskPath(id))) return id;
    }
    throw MarifoldError.taskInvalid('Could not create a unique task id.');
  }

  private createEventId(): string {
    return `evt_${crypto.randomBytes(8).toString('hex')}`;
  }

  private taskPath(taskId: string): string {
    this.assertSafeTaskId(taskId);
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  private assertSafeTaskId(taskId: string): void {
    if (!SAFE_TASK_ID.test(taskId)) {
      throw MarifoldError.taskInvalid(`Invalid task id '${taskId}'.`, taskId);
    }
  }

  private readFile(taskPath: string): TaskState {
    try {
      const parsed = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as Partial<TaskState>;
      return normalizeTaskState(parsed, taskPath);
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw MarifoldError.taskInvalid(`Could not read task ${taskPath}: ${String(error)}`);
    }
  }

  private write(task: TaskState): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    const taskPath = this.taskPath(task.id);
    const tempPath = `${taskPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(task, null, 2)}\n`);
    fs.renameSync(tempPath, taskPath);
  }
}

function normalizeTaskState(value: Partial<TaskState>, taskPath: string): TaskState {
  if (value.schema !== TASK_STATE_SCHEMA) {
    throw MarifoldError.taskInvalid(`Task file ${taskPath} has an unsupported schema.`);
  }
  const now = new Date().toISOString();
  const task: TaskState = {
    schema: TASK_STATE_SCHEMA,
    id: requiredText(value.id, 'id'),
    title: requiredText(value.title, 'title'),
    objective: requiredText(value.objective, 'objective'),
    status: normalizeTaskStatus(value.status ?? 'running'),
    tags: normalizeTags(value.tags),
    plan: normalizePlan(value.plan ?? [], now),
    events: normalizeEvents(value.events ?? []),
    createdAt: requiredText(value.createdAt, 'createdAt'),
    updatedAt: requiredText(value.updatedAt, 'updatedAt'),
    ...optionalField('profile', value.profile),
    ...optionalField('sessionId', value.sessionId),
    ...optionalField('summary', value.summary),
    ...optionalField('nextAction', value.nextAction),
    ...optionalField('completedAt', value.completedAt),
  };
  assertPlanInvariant(task.plan);
  return task;
}

function normalizePlan(items: TaskPlanInput[], timestamp: string): TaskPlanItem[] {
  if (!Array.isArray(items)) throw MarifoldError.taskInvalid('Task plan must be an array.');
  return items.map((item, index) => {
    const id = optionalText(item.id) ?? `step_${index + 1}`;
    const stored = item as Partial<TaskPlanItem>;
    if (!SAFE_TASK_ID.test(id)) throw MarifoldError.taskInvalid(`Invalid plan step id '${id}'.`);
    return {
      id,
      text: requiredText(item.text, `plan[${index}].text`),
      status: normalizeStepStatus(item.status ?? 'pending'),
      createdAt: optionalText(stored.createdAt) ?? timestamp,
      updatedAt: optionalText(stored.updatedAt) ?? timestamp,
    };
  });
}

function normalizeEvents(events: TaskEvent[]): TaskEvent[] {
  if (!Array.isArray(events)) throw MarifoldError.taskInvalid('Task events must be an array.');
  return events.map((event, index) => ({
    id: requiredText(event.id, `events[${index}].id`),
    kind: normalizeEventKind(event.kind),
    message: requiredText(event.message, `events[${index}].message`),
    createdAt: requiredText(event.createdAt, `events[${index}].createdAt`),
    ...optionalField('stepId', event.stepId),
    ...(event.metadata ? { metadata: normalizeMetadata(event.metadata) } : {}),
  }));
}

function assertPlanInvariant(plan: TaskPlanItem[]): void {
  const ids = new Set<string>();
  let activeCount = 0;
  for (const item of plan) {
    if (ids.has(item.id)) throw MarifoldError.taskInvalid(`Duplicate plan step id '${item.id}'.`);
    ids.add(item.id);
    if (item.status === 'in_progress') activeCount += 1;
  }
  if (activeCount > 1) {
    throw MarifoldError.taskInvalid('Task plan can have at most one in-progress step.');
  }
}

function countPlan(plan: TaskPlanItem[]): Record<TaskStepStatus, number> {
  const counts: Record<TaskStepStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const item of plan) counts[item.status] += 1;
  return counts;
}

function titleFromObjective(objective: string): string {
  const firstLine = objective.split(/\r?\n/)[0]?.trim() ?? objective;
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (text === undefined) throw MarifoldError.taskInvalid(`Task ${label} cannot be empty.`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw MarifoldError.taskInvalid('Expected task text fields to be strings.');
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalField<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  const text = optionalText(value);
  return text === undefined ? {} : { [key]: text } as Record<Key, string>;
}

function assignOptional<Key extends 'profile' | 'sessionId' | 'summary' | 'nextAction'>(
  task: TaskState,
  key: Key,
  value: unknown,
): void {
  if (value === undefined) return;
  const text = optionalText(value);
  if (text === undefined) delete task[key];
  else task[key] = text;
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw MarifoldError.taskInvalid('Task tags must be an array of strings.');
  return [...new Set(value.map(tag => requiredText(tag, 'tag')))].sort((a, b) => a.localeCompare(b));
}

function normalizeMetadata(value: Record<string, string>): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw MarifoldError.taskInvalid('Task event metadata must be an object.');
  }
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) throw MarifoldError.taskInvalid('Task event metadata keys cannot be empty.');
    if (typeof item !== 'string') throw MarifoldError.taskInvalid('Task event metadata values must be strings.');
    normalized[key] = item;
  }
  return normalized;
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  if (value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw MarifoldError.taskInvalid(`Invalid task status '${String(value)}'.`);
}

function normalizeStepStatus(value: unknown): TaskStepStatus {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'skipped' || value === 'cancelled') {
    return value;
  }
  throw MarifoldError.taskInvalid(`Invalid task step status '${String(value)}'.`);
}

function normalizeEventKind(value: unknown): TaskEventKind {
  if (value === 'progress' || value === 'decision' || value === 'observation' || value === 'blocker' || value === 'verification' || value === 'note') {
    return value;
  }
  throw MarifoldError.taskInvalid(`Invalid task event kind '${String(value)}'.`);
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw MarifoldError.taskInvalid('Task list limit must be a positive integer.');
  }
  return value;
}
