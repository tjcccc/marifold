import type { FastifyInstance } from 'fastify';
import {
  MarifoldError,
  type MarifoldRuntime,
  type TaskCreateInput,
  type TaskEventInput,
  type TaskEventKind,
  type TaskListOptions,
  type TaskPlanInput,
  type TaskStatus,
  type TaskUpdateInput,
} from '@marifold/core';
import { type JsonObject, objectBody, optionalStringField, parseLimitQuery, requiredString, stringArray, stringValue } from './Validation';

/** Ephemeral task-state CRUD. */
export function registerTaskRoutes(server: FastifyInstance, runtime: MarifoldRuntime): void {
  server.post('/v1/tasks', async (request, reply) => {
    reply.status(201);
    return {
      ok: true,
      task: runtime.createTask(parseTaskCreateInput(request.body)),
    };
  });

  server.get<{ Querystring: { status?: string; limit?: string } }>('/v1/tasks', async request => ({
    ok: true,
    tasks: runtime.listTasks(parseTaskListOptions(request.query)),
  }));

  server.get<{ Params: { id: string } }>('/v1/tasks/:id', async (request, reply) => {
    const task = runtime.getTask(request.params.id);
    if (!task) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task not found: ${request.params.id}`,
        },
      };
    }
    return { ok: true, task };
  });

  server.patch<{ Params: { id: string } }>('/v1/tasks/:id', async request => ({
    ok: true,
    task: runtime.updateTask(request.params.id, parseTaskUpdateInput(request.body)),
  }));

  server.post<{ Params: { id: string } }>('/v1/tasks/:id/events', async request => ({
    ok: true,
    task: runtime.appendTaskEvent(request.params.id, parseTaskEventInput(request.body)),
  }));

  server.delete<{ Params: { id: string } }>('/v1/tasks/:id', async request => ({
    ok: true,
    deleted: runtime.deleteTask(request.params.id),
  }));
}

function parseTaskCreateInput(value: unknown): TaskCreateInput {
  const body = objectBody(value);
  return {
    objective: requiredString(body.objective, 'objective'),
    ...optionalStringField('title', body.title),
    ...optionalStringField('profile', body.profile),
    ...optionalStringField('sessionId', body.sessionId),
    ...optionalStringField('summary', body.summary),
    ...optionalStringField('nextAction', body.nextAction),
    ...optionalTaskStatusField('status', body.status),
    ...optionalTagsField(body.tags),
    ...optionalPlanField(body.plan),
  };
}

function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
  const body = objectBody(value);
  const input: TaskUpdateInput = {};
  assignStringIfPresent(input, body, 'title');
  assignStringIfPresent(input, body, 'objective');
  assignStringIfPresent(input, body, 'profile');
  assignStringIfPresent(input, body, 'sessionId');
  assignStringIfPresent(input, body, 'summary');
  assignStringIfPresent(input, body, 'nextAction');
  if (Object.prototype.hasOwnProperty.call(body, 'status')) { input.status = taskStatus(body.status); }
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) { input.tags = stringArray(body.tags, 'tags'); }
  if (Object.prototype.hasOwnProperty.call(body, 'plan')) { input.plan = planArray(body.plan); }
  return input;
}

function parseTaskEventInput(value: unknown): TaskEventInput {
  const body = objectBody(value);
  return {
    message: requiredString(body.message, 'message'),
    ...(body.kind === undefined ? {} : { kind: taskEventKind(body.kind) }),
    ...optionalStringField('stepId', body.stepId),
    ...(body.metadata === undefined ? {} : { metadata: metadataObject(body.metadata) }),
  };
}

function parseTaskListOptions(query: { status?: string; limit?: string }): TaskListOptions {
  return {
    ...(query.status === undefined ? {} : { status: taskStatus(query.status) }),
    ...(query.limit === undefined ? {} : { limit: parseLimitQuery(query.limit) }),
  };
}

function optionalTaskStatusField<Key extends string>(key: Key, value: unknown): Record<Key, TaskStatus> | Record<string, never> {
  if (value === undefined) { return {}; }
  return { [key]: taskStatus(value) } as Record<Key, TaskStatus>;
}

function optionalTagsField(value: unknown): Pick<TaskCreateInput, 'tags'> {
  if (value === undefined) { return {}; }
  return { tags: stringArray(value, 'tags') };
}

function optionalPlanField(value: unknown): Pick<TaskCreateInput, 'plan'> {
  if (value === undefined) { return {}; }
  return { plan: planArray(value) };
}

function assignStringIfPresent(input: TaskUpdateInput, body: JsonObject, key: keyof TaskUpdateInput): void {
  if (!Object.prototype.hasOwnProperty.call(body, key)) { return; }
  const value = body[key];
  if (value === undefined) { return; }
  if (value === null) {
    input[key] = '' as never;
    return;
  }
  input[key] = stringValue(value, key) as never;
}

function planArray(value: unknown): TaskPlanInput[] {
  if (!Array.isArray(value)) { throw MarifoldError.configInvalid('plan must be an array.'); }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw MarifoldError.configInvalid(`plan[${index}] must be an object.`);
    }
    const step = item as JsonObject;
    return {
      text: requiredString(step.text, `plan[${index}].text`),
      ...optionalStringField('id', step.id),
      ...(step.status === undefined ? {} : { status: stepStatus(step.status) }),
    };
  });
}

function metadataObject(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw MarifoldError.configInvalid('metadata must be an object.');
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    metadata[key] = stringValue(item, `metadata.${key}`);
  }
  return metadata;
}

function taskStatus(value: unknown): TaskStatus {
  if (value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled') { return value; }
  throw MarifoldError.configInvalid(`Invalid task status '${String(value)}'.`);
}

function stepStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | 'skipped' | 'cancelled' {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'skipped' || value === 'cancelled') { return value; }
  throw MarifoldError.configInvalid(`Invalid task step status '${String(value)}'.`);
}

function taskEventKind(value: unknown): TaskEventKind {
  if (value === 'progress' || value === 'decision' || value === 'observation' || value === 'blocker' || value === 'verification' || value === 'note') { return value; }
  throw MarifoldError.configInvalid(`Invalid task event kind '${String(value)}'.`);
}
