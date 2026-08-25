import fastify, { FastifyInstance, FastifyReply } from 'fastify';
import {
  type AgentUsage,
  LoadedMarifoldConfig,
  MarifoldError,
  resolveAgentConfig,
  resolveWebSearchConfig,
  MarifoldProviderConfig,
  MarifoldRunRequest,
  MarifoldRuntime,
  MarifoldSkill,
  TaskCreateInput,
  TaskEventInput,
  TaskEventKind,
  TaskListOptions,
  TaskPlanInput,
  TaskStatus,
  TaskUpdateInput,
} from '@marifold/core';
import { registerProfileRoutes } from './ProfileRoutes';
import { registerRunRoutes } from './RunRoutes';
import { registerSecurity, resolveSecurityOptions } from './Security';
import { registerStaticRoutes, resolveBundledWebDir } from './StaticRoutes';
import { SSE_HEADERS, startSseHeartbeat, writeSse } from './Sse';
import {
  JsonObject,
  objectBody,
  optionalBooleanField,
  optionalImagesField,
  optionalNonNegativeIntegerField,
  optionalStringField,
  requiredString,
  stringArray,
  stringValue,
} from './Validation';

export interface MarifoldServiceOptions {
  loadedConfig: LoadedMarifoldConfig;
  /** Address the HTTP server will bind to. Defaults to loopback. */
  host?: string;
  logger?: boolean;
  /** Run the schedule scheduler inside this service process. Default true.
   * Schedules only fire while the service is running. */
  scheduler?: boolean;
  /** Bearer token override; falls back to [service].token_env / token. When
   * neither resolves, auth is disabled (bare loopback, the historic default). */
  auth?: { token?: string };
  /** Allowed browser origins override; falls back to [service].cors_origins. */
  cors?: { origins?: string[] };
  /** Built Web UI directory override; falls back to [service].web_dir.
   * When neither resolves, the service is API-only (no static hosting). */
  web?: { dir?: string };
}

export interface MarifoldServiceStartOptions extends MarifoldServiceOptions {
  port?: number;
}

export interface MarifoldServiceStartResult {
  server: FastifyInstance;
  address: string;
  host: string;
  port: number;
  /** Effective hosted Web UI directory, including the packaged default. */
  webDir?: string;
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
/** Base64 image attachments ride the JSON body; fastify's 1 MiB default
 * would reject them. Still gated by bind scope, source network, CORS, and any
 * configured bearer auth whenever the service leaves loopback. */
const BODY_LIMIT_BYTES = 25 * 1024 * 1024;

export function createMarifoldService(options: MarifoldServiceOptions): FastifyInstance {
  const host = options.host ?? DEFAULT_HOST;
  const security = resolveSecurityOptions(options.loadedConfig.config.service, {
    token: options.auth?.token,
    corsOrigins: options.cors?.origins,
  });

  const runtime = new MarifoldRuntime({ loadedConfig: options.loadedConfig });
  const server = fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT_BYTES });
  registerSecurity(server, {
    ...security,
    access: LOOPBACK_HOSTS.has(host) ? 'loopback' : 'private',
    boundHost: host,
  });

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

  const runRegistry = runtime.createRunRegistry(message => server.log.info(message));
  const skillAppInstances = runtime.createSkillAppInstanceRegistry();
  // Plain /ask and /chat/stream requests are not RunRegistry entries, but they
  // can still persist a final exchange. Keep session-scoped requests visible
  // to destructive history routes so a late completion cannot recreate a
  // session that was just deleted or truncated.
  const activeSessionRequests = new Map<string, number>();
  const activeProfileRequests = new Map<string, number>();
  const beginSessionRequest = (sessionId?: string, profile?: string): (() => void) => {
    if (sessionId) activeSessionRequests.set(sessionId, (activeSessionRequests.get(sessionId) ?? 0) + 1);
    if (profile) activeProfileRequests.set(profile, (activeProfileRequests.get(profile) ?? 0) + 1);
    return () => {
      if (sessionId) {
        const remaining = (activeSessionRequests.get(sessionId) ?? 1) - 1;
        if (remaining > 0) activeSessionRequests.set(sessionId, remaining);
        else activeSessionRequests.delete(sessionId);
      }
      if (profile) {
        const remaining = (activeProfileRequests.get(profile) ?? 1) - 1;
        if (remaining > 0) activeProfileRequests.set(profile, remaining);
        else activeProfileRequests.delete(profile);
      }
    };
  };
  const hasActiveSessionRequest = (sessionId: string): boolean =>
    (activeSessionRequests.get(sessionId) ?? 0) > 0;
  registerRunRoutes(server, runRegistry);
  registerProfileRoutes(server, runtime, {
    isProfileActive: profile =>
      (activeProfileRequests.get(profile) ?? 0) > 0
      || runRegistry.list().some(run => run.profile === profile && run.finishedAt === undefined),
  });

  const webDir = resolveServiceWebDir(options);
  if (webDir) registerStaticRoutes(server, webDir);

  server.addHook('onClose', async () => {
    telegramBridge?.stop();
    scheduler?.stop();
    runRegistry.close();
    skillAppInstances.close();
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
    config: publicConfig(options.loadedConfig, Boolean(security.token)),
  }));

  // Mirrors the CLI's `config set <key> <value>` exactly (same dotted-key
  // routing and validation); returns the sanitized view, never raw secrets.
  server.patch('/v1/config', async request => {
    const body = objectBody(request.body);
    runtime.setConfigValue(requiredString(body.key, 'key'), stringValue(body.value, 'value'));
    return { ok: true, config: publicConfig(options.loadedConfig, Boolean(security.token)) };
  });

  server.get('/v1/providers', async () => ({
    ok: true,
    providers: Object.entries(options.loadedConfig.config.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, provider]) => ({
        name,
        ...publicProvider(provider),
      })),
  }));

  // Live reachability probe for every provider (CLI `provider status`).
  // Sanitized: key/token presence booleans and env-var *names* only.
  server.get('/v1/providers/status', async () => ({
    ok: true,
    providers: await runtime.providerStatus(),
  }));

  // Models the provider actually serves right now (feeds the model picker).
  server.get<{ Params: { name: string } }>('/v1/providers/:name/models', async request => ({
    ok: true,
    ...(await runtime.listProviderModels(request.params.name)),
  }));

  server.delete<{ Params: { name: string } }>('/v1/providers/:name', async request => {
    const result = runtime.removeProvider(request.params.name);
    return {
      ok: true,
      ...result,
      config: publicConfig(options.loadedConfig, Boolean(security.token)),
      models: modelsView(options.loadedConfig),
    };
  });

  // Available skills (name + usage) for the composer's $-autocomplete,
  // profile-scoped so profile skills shadow global ones.
  server.get<{ Querystring: { profile?: string } }>('/v1/skills', async request => ({
    ok: true,
    skills: runtime.listSkills(request.query.profile).map(skillHint),
  }));

  // Resolve a `$skill [args]` invocation in code so Web/service clients do not
  // spend an agent loop searching the filesystem for a skill already indexed
  // by Marifold.
  server.post('/v1/skills/resolve', async request => {
    const body = objectBody(request.body);
    const profile = optionalStringField('profile', body.profile).profile;
    return {
      ok: true,
      invocation: runtime.resolveSkillInvocation(
        requiredString(body.invocation, 'invocation'),
        profile,
      ),
    };
  });

  // SkillApp source stays server-owned. Every renderer receives the same
  // statically compiled JSON contract and can only submit typed state.
  server.get('/v1/apps', async () => ({
    ok: true,
    apps: runtime.listApps(),
  }));

  server.get<{
    Params: { name: string };
  }>('/v1/apps/:name', async (request, reply) => {
    const app = runtime.getApp(request.params.name);
    if (!app) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'APP_NOT_FOUND',
          message: `App not found: ${request.params.name}`,
        },
      };
    }
    return { ok: true, app };
  });

  // SkillApps are statically compiled templates with ephemeral service-owned
  // state. Both buttons and on-change triggers execute the same declared
  // model + app-local Skill operation and return a normalized result.
  server.post<{
    Params: { name: string };
  }>('/v1/apps/:name/instances', async (request, reply) => {
    const instance = skillAppInstances.create(request.params.name);
    reply.status(201);
    return { ok: true, instance };
  });

  server.patch<{
    Params: { id: string };
  }>('/v1/app-instances/:id/state', async request => {
    const body = objectBody(request.body);
    return {
      ok: true,
      ...(await skillAppInstances.update(request.params.id, objectBody(body.values))),
    };
  });

  server.post<{
    Params: { id: string; operation: string };
  }>('/v1/app-instances/:id/operations/:operation', async request => ({
    ok: true,
    ...(await skillAppInstances.run(request.params.id, request.params.operation)),
  }));

  server.delete<{
    Params: { id: string };
  }>('/v1/app-instances/:id', async request => ({
    ok: true,
    deleted: skillAppInstances.delete(request.params.id),
  }));

  server.get('/v1/models', async () => ({
    ok: true,
    default: {
      provider: options.loadedConfig.config.default.provider,
      model: options.loadedConfig.config.default.model,
    },
    options: [...options.loadedConfig.config.models.options],
  }));

  // Model management (CLI `model add`/`rm`/`default`). Provider entries may be
  // created/updated here, but never with secrets — raw api_key values stay
  // CLI/file-only by design; the wire accepts the env-var *name* at most.
  server.post('/v1/models', async (request, reply) => {
    const body = objectBody(request.body);
    runtime.addModelOption(requiredString(body.provider, 'provider'), requiredString(body.model, 'model'), {
      ...(body.type !== undefined ? { type: parseProviderTypeField(body.type) } : {}),
      ...optionalStringField('baseUrl', body.baseUrl),
      ...optionalStringField('apiKeyEnv', body.apiKeyEnv),
    });
    reply.status(201);
    return modelsView(options.loadedConfig);
  });

  server.delete('/v1/models', async request => {
    const body = objectBody(request.body);
    const result = runtime.removeModelOption(
      requiredString(body.provider, 'provider'),
      requiredString(body.model, 'model'),
    );
    return { ...modelsView(options.loadedConfig), ...result };
  });

  server.put('/v1/models/default', async request => {
    const body = objectBody(request.body);
    runtime.setDefaultModel(requiredString(body.provider, 'provider'), requiredString(body.model, 'model'));
    return modelsView(options.loadedConfig);
  });

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

  server.get<{ Querystring: { limit?: string; profile?: string; archived?: string; q?: string } }>('/v1/sessions', async request => ({
    ok: true,
    sessions: runtime.listSessions(
      parseLimitQuery(request.query.limit) ?? 50,
      request.query.profile,
      {
        archived: parseBooleanQuery(request.query.archived),
        ...(request.query.q?.trim() ? { search: request.query.q } : {}),
      },
    ),
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

  server.get<{
    Params: { id: string; userTurnIndex: string; attachmentIndex: string };
  }>('/v1/sessions/:id/attachments/:userTurnIndex/:attachmentIndex', async (request, reply) => {
    const userTurnIndex = nonNegativeIntegerPath(request.params.userTurnIndex, 'userTurnIndex');
    const attachmentIndex = nonNegativeIntegerPath(request.params.attachmentIndex, 'attachmentIndex');
    const attachment = runtime.getSessionAttachment(request.params.id, userTurnIndex, attachmentIndex);
    if (!attachment?.data) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'SESSION_ATTACHMENT_NOT_FOUND',
          message: 'Session attachment not found.',
        },
      };
    }
    reply
      .type(attachment.mediaType)
      .header('cache-control', 'private, max-age=60')
      .header('x-content-type-options', 'nosniff');
    return reply.send(Buffer.from(attachment.data, 'base64'));
  });

  server.patch<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    const body = objectBody(request.body);
    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const hasPinned = Object.prototype.hasOwnProperty.call(body, 'pinned');
    const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
    if (!hasTitle && !hasPinned && !hasArchived) {
      throw MarifoldError.configInvalid('At least one of title, pinned, or archived is required.');
    }
    if (hasTitle && body.title !== null && typeof body.title !== 'string') {
      throw MarifoldError.configInvalid('title must be a string or null.');
    }
    if (hasPinned && typeof body.pinned !== 'boolean') {
      throw MarifoldError.configInvalid('pinned must be a boolean.');
    }
    if (hasArchived && typeof body.archived !== 'boolean') {
      throw MarifoldError.configInvalid('archived must be a boolean.');
    }
    const updated = runtime.updateSessionDisplay(request.params.id, {
      ...(hasTitle ? { title: body.title as string | null } : {}),
      ...(hasPinned ? { pinned: body.pinned as boolean } : {}),
      ...(hasArchived ? { archived: body.archived as boolean } : {}),
    });
    if (!updated) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${request.params.id}`,
        },
      };
    }
    return { ok: true, session: runtime.getSession(request.params.id) };
  });

  server.delete<{ Params: { id: string } }>('/v1/sessions/:id', async request => {
    if (
      hasActiveSessionRequest(request.params.id)
      || runRegistry.list().some(run => run.sessionId === request.params.id && run.status === 'running')
    ) {
      throw MarifoldError.agentRunInvalid(
        'Cancel the active request and wait for it to finish before deleting this session.',
      );
    }
    return {
      ok: true,
      deleted: runtime.deleteSession(request.params.id),
    };
  });

  server.post<{ Params: { id: string } }>('/v1/sessions/:id/truncate', async (request, reply) => {
    const body = objectBody(request.body);
    const userTurnIndex = body.fromUserTurnIndex;
    if (typeof userTurnIndex !== 'number' || !Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
      throw MarifoldError.configInvalid('fromUserTurnIndex must be a non-negative integer.');
    }
    if (
      hasActiveSessionRequest(request.params.id)
      || runRegistry.list().some(run => run.sessionId === request.params.id && run.status === 'running')
    ) {
      throw MarifoldError.agentRunInvalid('Cancel the active request before editing this session history.');
    }
    const result = runtime.truncateSessionFromUserTurn(request.params.id, userTurnIndex);
    if (!result.found) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${request.params.id}`,
        },
      };
    }
    return { ok: true, truncated: result.removedTurns > 0, removedTurns: result.removedTurns };
  });

  // Manually compact a session now (the /compact command): summarize older turns.
  server.post<{ Params: { id: string } }>('/v1/sessions/:id/compact', async request => {
    const body = objectBody(request.body);
    const result = await runtime.compactSession(request.params.id, {
      profile: requiredString(body.profile, 'profile'),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.think === 'boolean' ? { think: body.think } : {}),
    });
    return { ok: true, ...result };
  });

  server.post('/v1/ask', async request => {
    const input = parseRunRequest(request.body);
    const endRequest = beginSessionRequest(
      input.sessionId,
      input.profile ?? options.loadedConfig.config.default.profile,
    );
    try {
      return {
        ok: true,
        response: await runtime.ask(input),
      };
    } finally {
      endRequest();
    }
  });

  server.post('/v1/chat/stream', async (request, reply) => {
    const input = parseRunRequest(request.body);
    const endRequest = beginSessionRequest(
      input.sessionId,
      input.profile ?? options.loadedConfig.config.default.profile,
    );
    try {
      await streamChat(reply, runtime, input);
    } finally {
      endRequest();
    }
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
  const webDir = resolveServiceWebDir(options);
  const server = createMarifoldService({ ...options, host, web: { dir: webDir } });
  try {
    const address = await server.listen({ host, port });
    return {
      server,
      address,
      host,
      port,
      ...(webDir ? { webDir } : {}),
      telegram: (server as ServiceWithBridge).marifoldTelegram,
    };
  } catch (error) {
    // createMarifoldService starts the scheduler/runtime before listen().
    // Always run Fastify's onClose hooks when binding fails, otherwise an
    // EADDRINUSE attempt leaves a ghost process alive on those background
    // handles even though it never served a request.
    try {
      await server.close();
    } catch {
      // Preserve the actionable listen error. Close is best-effort here, and
      // individual lifecycle owners also stop from the onClose hook.
    }
    throw error;
  }
}

function resolveServiceWebDir(options: MarifoldServiceOptions): string | undefined {
  return options.web?.dir
    ?? options.loadedConfig.config.service?.webDir
    ?? resolveBundledWebDir();
}

async function streamChat(reply: FastifyReply, runtime: MarifoldRuntime, request: MarifoldRunRequest): Promise<void> {
  let closed = false;
  let completion: { usage?: AgentUsage; latencyMs?: number } | undefined;
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
  // No id:/retry: here on purpose — a chat POST is one-shot (an EventSource
  // reconnect would re-run the prompt); only the runs stream is resumable.
  const stopHeartbeat = startSseHeartbeat(reply);

  try {
    for await (const chunk of runtime.stream(
      { ...request, signal: abort.signal },
      summary => {
        completion = summary;
      },
      text => {
        if (!closed) writeSse(reply, 'reasoning', { text });
      },
    )) {
      if (closed) break;
      writeSse(reply, 'chunk', { text: chunk });
    }
    if (!closed) {
      writeSse(reply, 'done', {
        ...(completion?.usage ? { usage: completion.usage } : {}),
        ...(completion?.latencyMs !== undefined ? { latencyMs: completion.latencyMs } : {}),
      });
    }
  } catch (error) {
    if (!closed) {
      writeSse(reply, 'error', normalizeError(error).error);
      writeSse(reply, 'done', {});
    }
  } finally {
    stopHeartbeat();
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
    ...optionalStringField('userTurn', body.userTurn),
    ...optionalBooleanField('isolated', body.isolated),
    ...optionalNonNegativeIntegerField('replaceUserTurnIndex', body.replaceUserTurnIndex),
    ...optionalBooleanField('memories', body.memories),
    ...optionalBooleanField('think', body.think),
    ...optionalBooleanField('profileContext', body.profileContext),
    ...optionalBooleanField('originalImages', body.originalImages),
    ...optionalImagesField(body.images),
    ...(body.instructions !== undefined ? { instructions: stringArray(body.instructions, 'instructions') } : {}),
  };
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

const PROVIDER_TYPES = ['ollama', 'openai-compatible', 'anthropic'] as const;

function parseProviderTypeField(value: unknown): (typeof PROVIDER_TYPES)[number] {
  const type = stringValue(value, 'type');
  const known = PROVIDER_TYPES.find(candidate => candidate === type);
  if (!known) throw MarifoldError.configInvalid(`type must be one of ${PROVIDER_TYPES.join(', ')}.`);
  return known;
}

/** The GET /v1/models payload — returned by every model write for refresh-free clients. */
function modelsView(loadedConfig: LoadedMarifoldConfig): JsonObject {
  return {
    ok: true,
    default: {
      provider: loadedConfig.config.default.provider,
      model: loadedConfig.config.default.model,
    },
    options: [...loadedConfig.config.models.options],
  };
}

function publicConfig(loadedConfig: LoadedMarifoldConfig, hasEffectiveToken: boolean): JsonObject {
  const service = loadedConfig.config.service;
  return {
    default: loadedConfig.config.default,
    models: loadedConfig.config.models,
    memory: loadedConfig.config.memory,
    paths: loadedConfig.config.paths,
    // Resolved (defaults merged) and secret-free — clients need the global
    // [agent] to compute a profile's effective permissions.
    agent: resolveAgentConfig(loadedConfig.config.agent) as unknown as JsonObject,
    webSearch: (() => {
      const search = resolveWebSearchConfig(loadedConfig.config.webSearch);
      return {
        enabled: search.enabled,
        maxResults: search.maxResults,
        provider: search.provider,
        ...(search.apiKeyEnv ? { apiKeyEnv: search.apiKeyEnv } : {}),
        ...(search.scrape !== undefined ? { scrape: search.scrape } : {}),
        ...(search.proxy ? { proxy: search.proxy } : {}),
        hasApiKey: Boolean(search.apiKey),
      };
    })(),
    // Sanitized [service] view: the token value never leaves the process.
    service: {
      ...(service?.webDir ? { webDir: service.webDir } : {}),
      ...(service?.tokenEnv ? { tokenEnv: service.tokenEnv } : {}),
      corsOrigins: service?.corsOrigins ?? [],
      hasToken: hasEffectiveToken,
    },
    providers: Object.fromEntries(
      Object.entries(loadedConfig.config.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, provider]) => [name, publicProvider(provider)]),
    ),
  };
}

function skillHint(skill: MarifoldSkill): JsonObject {
  const vars = skill.variables
    .map(variable => (variable.required ? `<${variable.name}>` : `[${variable.name}]`))
    .join(' ');
  return {
    name: skill.name,
    description: skill.description,
    usage: `$${skill.name}${vars ? ` ${vars}` : ''}`,
  };
}

function publicProvider(provider: MarifoldProviderConfig): JsonObject {
  return {
    type: provider.type,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    // proxy is a non-secret URL like baseUrl, so it crosses the wire in the
    // clear (unlike api_key). A proxy URL *can* embed credentials
    // (user:pass@host); that's the caller's choice, same as a secret in baseUrl.
    ...(provider.proxy ? { proxy: provider.proxy } : {}),
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
    || error.code === 'SKILL_NOT_FOUND'
    || error.code === 'APP_NOT_FOUND'
    || error.code === 'RUN_NOT_FOUND'
    || error.code === 'APPROVAL_NOT_FOUND'
    || error.code === 'USER_INPUT_NOT_FOUND'
  ) {
    return 404;
  }
  if (
    error.code === 'CONFIG_INVALID'
    || error.code === 'IMAGE_INVALID'
    || error.code === 'PROFILE_INVALID'
    || error.code === 'MEMORY_INVALID'
    || error.code === 'TASK_INVALID'
    || error.code === 'SCHEDULE_INVALID'
    || error.code === 'AGENT_TOOL_INVALID'
    || error.code === 'AGENT_RUN_INVALID'
    || error.code === 'SKILL_INVALID'
    || error.code === 'APP_INVALID'
  ) {
    return 400;
  }
  if (error.code === 'CONFIG_FILE_NOT_FOUND') return 404;
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'NETWORK_FORBIDDEN' || error.code === 'ORIGIN_FORBIDDEN') return 403;
  if (error.code === 'RUN_LIMIT_EXCEEDED') return 429;
  if (error.code === 'PROVIDER_ERROR') return 502;
  return 500;
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

function nonNegativeIntegerPath(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw MarifoldError.configInvalid(`${name} must be a non-negative integer.`);
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
