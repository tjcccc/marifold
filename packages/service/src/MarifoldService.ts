import fastify, { FastifyInstance, FastifyReply } from 'fastify';
import {
  LoadedMarifoldConfig,
  MarifoldError,
  MarifoldProviderConfig,
  MarifoldRunRequest,
  MarifoldRuntime,
  TaskCreateInput,
  TaskEventInput,
  TaskEventKind,
  TaskListOptions,
  TaskPlanInput,
  TaskStatus,
  TaskUpdateInput,
} from '@marifold/core';
import { registerSecurity, resolveSecurityOptions } from './Security';
import { SSE_HEADERS, writeSse } from './Sse';

export interface MarifoldServiceOptions {
  loadedConfig: LoadedMarifoldConfig;
  logger?: boolean;
  /** Run the schedule scheduler inside this service process. Default true.
   * Schedules only fire while the service is running. */
  scheduler?: boolean;
  /** Bearer token override; falls back to [service].token_env / token. When
   * neither resolves, auth is disabled (bare loopback, the historic default). */
  auth?: { token?: string };
  /** Allowed browser origins override; falls back to [service].cors_origins. */
  cors?: { origins?: string[] };
}

export interface MarifoldServiceStartOptions extends MarifoldServiceOptions {
  host?: string;
  port?: number;
}

export interface MarifoldServiceStartResult {
  server: FastifyInstance;
  address: string;
  host: string;
  port: number;
  /** Present when the Telegram bridge started inside this service. */
  telegram?: { profile: string };
}

/** Internal: the active Telegram bridge info stashed on the Fastify instance so
 * startMarifoldService can report it without changing createMarifoldService's
 * return type. */
type ServiceWithBridge = FastifyInstance & { marifoldTelegram?: { profile: string } };

const API_VERSION = 'v1';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 32140;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

type JsonObject = Record<string, unknown>;

export function createMarifoldService(options: MarifoldServiceOptions): FastifyInstance {
  const runtime = new MarifoldRuntime({ loadedConfig: options.loadedConfig });
  const server = fastify({ logger: options.logger ?? false });

  registerSecurity(server, resolveSecurityOptions(options.loadedConfig.config.service, {
    token: options.auth?.token,
    corsOrigins: options.cors?.origins,
  }));

  const scheduler = (options.scheduler ?? true)
    ? runtime.createScheduler(message => server.log.info(message))
    : undefined;
  scheduler?.start();

  // Messaging bridge(s) run inside the same long-lived process as the HTTP API
  // and scheduler, so one `marifold service` powers everything (TUI, future
  // Web/desktop/mobile, Telegram).
  const telegramBridge = runtime.createTelegramBridge(message => server.log.info(message));
  telegramBridge?.start();
  (server as ServiceWithBridge).marifoldTelegram = telegramBridge ? { profile: telegramBridge.profile } : undefined;

  server.addHook('onClose', async () => {
    telegramBridge?.stop();
    scheduler?.stop();
    runtime.close();
  });

  server.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeError(error);
    reply.status(normalized.statusCode).send({
      ok: false,
      error: normalized.error,
    });
  });

  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${request.method} ${request.url}`,
      },
    });
  });

  server.get('/health', async () => ({
    ok: true,
    service: 'marifold',
    apiVersion: API_VERSION,
  }));

  server.get('/v1/status', async () => ({
    ok: true,
    service: 'marifold',
    apiVersion: API_VERSION,
    localOnly: true,
    configPath: options.loadedConfig.configPath,
    foundConfig: options.loadedConfig.foundConfig,
    default: options.loadedConfig.config.default,
    paths: options.loadedConfig.config.paths,
  }));

  server.get('/v1/config', async () => ({
    ok: true,
    config: publicConfig(options.loadedConfig),
  }));

  server.get('/v1/providers', async () => ({
    ok: true,
    providers: Object.entries(options.loadedConfig.config.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, provider]) => ({
        name,
        ...publicProvider(provider),
      })),
  }));

  server.get('/v1/models', async () => ({
    ok: true,
    default: {
      provider: options.loadedConfig.config.default.provider,
      model: options.loadedConfig.config.default.model,
    },
    options: [...options.loadedConfig.config.models.options],
  }));

  server.get('/v1/profiles', async () => ({
    ok: true,
    profiles: runtime.listProfiles(),
  }));

  server.get<{ Params: { name: string } }>('/v1/profiles/:name', async request => ({
    ok: true,
    profile: runtime.getProfile(request.params.name),
  }));

  server.get<{
    Params: { name: string };
    Querystring: { all?: string; limit?: string };
  }>('/v1/profiles/:name/memories', async request => {
    const includeSuperseded = parseBooleanQuery(request.query.all);
    const limit = parseLimitQuery(request.query.limit);
    const entries = runtime.listMemories(request.params.name, includeSuperseded);
    return {
      ok: true,
      profile: request.params.name,
      memories: limit === undefined ? entries : entries.slice(0, limit),
    };
  });

  server.get<{ Querystring: { limit?: string; profile?: string } }>('/v1/sessions', async request => ({
    ok: true,
    sessions: runtime.listSessions(parseLimitQuery(request.query.limit) ?? 50, request.query.profile),
  }));

  server.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    const session = runtime.getSession(request.params.id);
    if (!session) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${request.params.id}`,
        },
      };
    }
    return { ok: true, session };
  });

  server.delete<{ Params: { id: string } }>('/v1/sessions/:id', async request => ({
    ok: true,
    deleted: runtime.deleteSession(request.params.id),
  }));

  server.post('/v1/ask', async request => ({
    ok: true,
    response: await runtime.ask(parseRunRequest(request.body)),
  }));

  server.post('/v1/chat/stream', async (request, reply) => {
    await streamChat(reply, runtime, parseRunRequest(request.body));
  });

  server.get('/v1/schedules', async () => ({
    ok: true,
    schedules: runtime.listSchedules(),
  }));

  server.get<{ Params: { id: string } }>('/v1/schedules/:id', async (request, reply) => {
    const schedule = runtime.getSchedule(request.params.id);
    if (!schedule) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'SCHEDULE_NOT_FOUND',
          message: `Schedule not found: ${request.params.id}`,
        },
      };
    }
    return { ok: true, schedule };
  });

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

  return server;
}

export async function startMarifoldService(options: MarifoldServiceStartOptions): Promise<MarifoldServiceStartResult> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  assertLoopbackHost(host);
  const server = createMarifoldService(options);
  const address = await server.listen({ host, port });
  return { server, address, host, port, telegram: (server as ServiceWithBridge).marifoldTelegram };
}

function assertLoopbackHost(host: string): void {
  if (LOOPBACK_HOSTS.has(host)) return;
  throw MarifoldError.configInvalid(
    `Marifold service is loopback-only in this release. Use ${DEFAULT_HOST}, localhost, or ::1.`,
    { host },
  );
}

async function streamChat(reply: FastifyReply, runtime: MarifoldRuntime, request: MarifoldRunRequest): Promise<void> {
  let closed = false;
  // A disconnected client must tear down the in-flight provider request, not
  // just stop the SSE writes — otherwise the model keeps generating unbilled-
  // for output after the browser tab is gone.
  const abort = new AbortController();
  reply.hijack();
  reply.raw.on('close', () => {
    closed = true;
    abort.abort();
  });
  reply.raw.writeHead(200, SSE_HEADERS);

  try {
    for await (const chunk of runtime.stream({ ...request, signal: abort.signal })) {
      if (closed) break;
      writeSse(reply, 'chunk', { text: chunk });
    }
    if (!closed) writeSse(reply, 'done', {});
  } catch (error) {
    if (!closed) {
      writeSse(reply, 'error', normalizeError(error).error);
      writeSse(reply, 'done', {});
    }
  } finally {
    if (!closed) reply.raw.end();
  }
}

function parseRunRequest(value: unknown): MarifoldRunRequest {
  const body = objectBody(value);
  return {
    prompt: requiredString(body.prompt, 'prompt'),
    ...optionalStringField('profile', body.profile),
    ...optionalStringField('provider', body.provider),
    ...optionalStringField('model', body.model),
    ...optionalStringField('sessionId', body.sessionId),
    ...optionalBooleanField('memories', body.memories),
    ...optionalBooleanField('think', body.think),
    ...optionalImagesField(body.images),
  };
}

// App clients send images as base64 payloads ({data, mediaType}) or URLs;
// local file paths are not accepted over the service boundary.
function optionalImagesField(value: unknown): { images: NonNullable<MarifoldRunRequest['images']> } | Record<string, never> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw MarifoldError.configInvalid('Expected images to be an array.');
  const images = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw MarifoldError.configInvalid(`Expected images[${index}] to be an object.`);
    }
    const image = item as { data?: unknown; url?: unknown; mediaType?: unknown };
    const data = typeof image.data === 'string' && image.data ? image.data : undefined;
    const url = typeof image.url === 'string' && image.url ? image.url : undefined;
    if ((data === undefined) === (url === undefined)) {
      throw MarifoldError.configInvalid(`Expected images[${index}] to set exactly one of data or url.`);
    }
    return {
      ...(data !== undefined ? { data } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(typeof image.mediaType === 'string' && image.mediaType ? { mediaType: image.mediaType } : {}),
    };
  });
  return { images };
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
  if (Object.prototype.hasOwnProperty.call(body, 'status')) input.status = taskStatus(body.status);
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) input.tags = stringArray(body.tags, 'tags');
  if (Object.prototype.hasOwnProperty.call(body, 'plan')) input.plan = planArray(body.plan);
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

function publicConfig(loadedConfig: LoadedMarifoldConfig): JsonObject {
  return {
    default: loadedConfig.config.default,
    models: loadedConfig.config.models,
    memory: loadedConfig.config.memory,
    paths: loadedConfig.config.paths,
    providers: Object.fromEntries(
      Object.entries(loadedConfig.config.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, provider]) => [name, publicProvider(provider)]),
    ),
  };
}

function publicProvider(provider: MarifoldProviderConfig): JsonObject {
  return {
    type: provider.type,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    hasApiKey: Boolean(provider.apiKey),
    hasOauthToken: Boolean(provider.oauthToken),
    hasApiKeyExpiresAt: provider.apiKeyExpiresAt !== undefined,
  };
}

function normalizeError(error: unknown): { statusCode: number; error: JsonObject } {
  if (error instanceof MarifoldError) {
    return {
      statusCode: statusCodeForError(error),
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      },
    };
  }
  if (error instanceof Error) {
    return {
      statusCode: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
      },
    };
  }
  return {
    statusCode: 500,
    error: {
      code: 'INTERNAL_ERROR',
      message: String(error),
    },
  };
}

function statusCodeForError(error: MarifoldError): number {
  if (
    error.code === 'TASK_NOT_FOUND'
    || error.code === 'SCHEDULE_NOT_FOUND'
    || error.code === 'RUN_NOT_FOUND'
    || error.code === 'APPROVAL_NOT_FOUND'
  ) {
    return 404;
  }
  if (
    error.code === 'CONFIG_INVALID'
    || error.code === 'PROFILE_INVALID'
    || error.code === 'MEMORY_INVALID'
    || error.code === 'TASK_INVALID'
    || error.code === 'SCHEDULE_INVALID'
    || error.code === 'AGENT_RUN_INVALID'
  ) {
    return 400;
  }
  if (error.code === 'CONFIG_FILE_NOT_FOUND') return 404;
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'ORIGIN_FORBIDDEN') return 403;
  if (error.code === 'RUN_LIMIT_EXCEEDED') return 429;
  return 500;
}

function objectBody(value: unknown): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject;
  throw MarifoldError.configInvalid('Expected a JSON object request body.');
}

function requiredString(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text.trim()) throw MarifoldError.configInvalid(`${label} cannot be empty.`);
  return text;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw MarifoldError.configInvalid(`${label} must be a string.`);
  return value;
}

function optionalStringField<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  if (value === undefined) return {};
  return { [key]: stringValue(value, key) } as Record<Key, string>;
}

function optionalBooleanField<Key extends string>(key: Key, value: unknown): Record<Key, boolean> | Record<string, never> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw MarifoldError.configInvalid(`${key} must be a boolean.`);
  return { [key]: value } as Record<Key, boolean>;
}

function optionalTaskStatusField<Key extends string>(key: Key, value: unknown): Record<Key, TaskStatus> | Record<string, never> {
  if (value === undefined) return {};
  return { [key]: taskStatus(value) } as Record<Key, TaskStatus>;
}

function optionalTagsField(value: unknown): Pick<TaskCreateInput, 'tags'> {
  if (value === undefined) return {};
  return { tags: stringArray(value, 'tags') };
}

function optionalPlanField(value: unknown): Pick<TaskCreateInput, 'plan'> {
  if (value === undefined) return {};
  return { plan: planArray(value) };
}

function assignStringIfPresent(input: TaskUpdateInput, body: JsonObject, key: keyof TaskUpdateInput): void {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return;
  const value = body[key];
  if (value === undefined) return;
  if (value === null) {
    input[key] = '' as never;
    return;
  }
  input[key] = stringValue(value, key) as never;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw MarifoldError.configInvalid(`${label} must be an array of strings.`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

function planArray(value: unknown): TaskPlanInput[] {
  if (!Array.isArray(value)) throw MarifoldError.configInvalid('plan must be an array.');
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

function parseLimitQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw MarifoldError.configInvalid('limit must be a positive integer.');
  }
  return parsed;
}

function parseBooleanQuery(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw MarifoldError.configInvalid('Boolean query values must be true or false.');
}

function taskStatus(value: unknown): TaskStatus {
  if (value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled') return value;
  throw MarifoldError.configInvalid(`Invalid task status '${String(value)}'.`);
}

function stepStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | 'skipped' | 'cancelled' {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'skipped' || value === 'cancelled') return value;
  throw MarifoldError.configInvalid(`Invalid task step status '${String(value)}'.`);
}

function taskEventKind(value: unknown): TaskEventKind {
  if (value === 'progress' || value === 'decision' || value === 'observation' || value === 'blocker' || value === 'verification' || value === 'note') return value;
  throw MarifoldError.configInvalid(`Invalid task event kind '${String(value)}'.`);
}
