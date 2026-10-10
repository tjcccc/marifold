import { ArtifactWebRtc, DeviceExecution } from '@marifold/core';
import { remoteArtifactDownload } from './RemoteArtifactDownload';
import { requestEnvironment, requestOrigin } from './RequestEnvironment';
import { registerWorkspaceScheduleRoutes } from './WorkspaceScheduleRoutes';
import * as path from 'node:path';
import { registerSessionOwners } from './SessionOwner';
import { WorkspaceRequestContext } from './WorkspaceRequestContext';
import fastify, { type FastifyInstance } from 'fastify';
import {
  workspaceTerminal,
  WorkspaceManager,
  WorkspaceExecutor,
  WorkspaceRuns,
  type LoadedMarifoldConfig,
  MarifoldError,
  MarifoldRuntime,
} from '@marifold/core';
import { registerWorkspaceRoutes, remoteExecution } from './WorkspaceRoutes';
import { registerProfileRoutes } from './ProfileRoutes';
import { registerChatRoutes } from './ChatRoutes';
import { registerConfigRoutes } from './ConfigRoutes';
import { normalizeError } from './ServiceErrors';
import { registerSessionRoutes } from './SessionRoutes';
import { registerSkillAppRoutes } from './SkillAppRoutes';
import { registerTaskRoutes } from './TaskRoutes';
import { ArtifactTickets, artifactHeaders } from './ArtifactTickets';
import { registerRunRoutes } from './RunRoutes';
import { registerSecurity, resolveSecurityOptions } from './Security';
import { registerStaticRoutes, resolveBundledWebDir } from './StaticRoutes';

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
  const artifactTickets = new ArtifactTickets();
  registerSecurity(server, {
    authorizeArtifact: artifactTickets.authorize,
    ...security,
    access: LOOPBACK_HOSTS.has(host) ? 'loopback' : 'private',
    boundHost: host,
  });

  artifactTickets.register(server);

  let workspaceManager: WorkspaceManager;
  try { workspaceManager = new WorkspaceManager(options.loadedConfig.configPath); }
  catch (error) { runtime.close(); throw error; }

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

  const artifactTransfers = new ArtifactWebRtc();
  server.addHook('onClose', async () => artifactTransfers.close());
  const workspaceExecutor = new WorkspaceExecutor(() => runtime.resolveAgentConfigForProfile(), path.join(workspaceManager.store.directory, 'runs'), [options.loadedConfig.configPath, ...Object.values(options.loadedConfig.config.paths).filter((value): value is string => typeof value === 'string'), path.dirname(workspaceManager.store.directory)], artifactTransfers, new DeviceExecution(options.loadedConfig.configPath));
  const workspaceRuns = new WorkspaceRuns(runtime, workspaceManager);
  const workspaceContext = new WorkspaceRequestContext();
  registerSessionOwners(server, workspaceContext);
  const runRegistry = runtime.createRunRegistry(message => server.log.info(message), input => workspaceRuns.createRunner(input), workspaceManager.store.runJournal);
  workspaceManager.onMembershipRemoved = (workspaceId, deviceId) => {
    artifactTransfers.cancelWorkspace(workspaceId);
    for (const run of runRegistry.list()) { const execution = run.execution; if (!run.finishedAt && execution?.workspaceId === workspaceId && (!deviceId || execution.originDeviceId === deviceId || execution.executionDeviceId === deviceId)) { runRegistry.cancel(run.id); } }
  };
  // A revoked guest stops executing the host's work at once instead of when
  // its execution lease expires; the host can no longer reach it to cancel.
  workspaceManager.onPairingRefused = workspaceId => {
    workspaceExecutor.cancelWorkspace(workspaceId);
    artifactTransfers.cancelWorkspace(workspaceId);
  };
  workspaceRuns.setDelegate((parent, input) => { const child = runRegistry.startChild(parent, input); return { runId: child.id, events: runRegistry.events(child.id), cancel: () => { runRegistry.cancel(child.id); } }; });
  const skillAppInstances = runtime.createSkillAppInstanceRegistry();
  // Plain /ask and /chat/stream requests are not RunRegistry entries, but they
  // can still persist a final exchange. Keep session-scoped requests visible
  // to destructive history routes so a late completion cannot recreate a
  // session that was just deleted or truncated.
  const activeSessionRequests = new Map<string, number>();
  const activeProfileRequests = new Map<string, number>();
  const beginSessionRequest = (sessionId?: string, profile?: string): (() => void) => {
    if (sessionId) {
      const owner = runRegistry.list().find(run => run.sessionId === sessionId && !run.finishedAt);
      if (owner || activeSessionRequests.has(sessionId)) { throw new MarifoldError('SESSION_BUSY', 'Session already has an active request.', { sessionId, ...(owner ? { runId: owner.id } : {}) }); }
    }
    if (sessionId) { activeSessionRequests.set(sessionId, (activeSessionRequests.get(sessionId) ?? 0) + 1); }
    if (profile) { activeProfileRequests.set(profile, (activeProfileRequests.get(profile) ?? 0) + 1); }
    return () => {
      if (sessionId) {
        const remaining = (activeSessionRequests.get(sessionId) ?? 1) - 1;
        if (remaining > 0) { activeSessionRequests.set(sessionId, remaining); }
        else { activeSessionRequests.delete(sessionId); }
      }
      if (profile) {
        const remaining = (activeProfileRequests.get(profile) ?? 1) - 1;
        if (remaining > 0) { activeProfileRequests.set(profile, remaining); }
        else { activeProfileRequests.delete(profile); }
      }
    };
  };
  const hasActiveSessionRequest = (sessionId: string): boolean =>
    (activeSessionRequests.get(sessionId) ?? 0) > 0;
  server.get('/v1/execution-devices', async request => ({
    ok: true, devices: workspaceRuns.devices(workspaceContext.resolve(request.headers)),
  }));
  registerRunRoutes(server, runRegistry, {
    tickets: artifactTickets,
    preview: async (runId, artifactId, variant) => {
      const origin = runRegistry.artifactOrigin(runId, artifactId);
      const e = remoteExecution(workspaceManager, origin.run.execution);
      if (!e) { return undefined; }
      const result = await workspaceManager.execute(e.workspaceId, e.executionDeviceId, 'executor.artifact', { runId: origin.run.id, artifactId: origin.artifactId, preview: true, variant }) as { data: string };
      return Buffer.from(result.data, 'base64');
    },
    resolve: (input, body, request) => {
      if (input.sessionId && activeSessionRequests.has(input.sessionId)) { throw new MarifoldError('SESSION_BUSY', 'Session already has an active request.', { sessionId: input.sessionId }); }
      // Refuse up front (409) instead of failing the run after it starts.
      if (input.sessionId) { runtime.assertSessionWritable(input.sessionId); }
      return workspaceRuns.resolve({ ...input, sessionOwner: request.sessionOwner, environment: requestEnvironment(request, workspaceContext.resolve(request.headers)) }, {
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      executionDeviceId: typeof body.executionDeviceId === 'string' ? body.executionDeviceId : undefined,
    }, workspaceContext.resolve(request.headers)); },
    artifactAvailable: async (runId, artifactId) => {
      const origin = runRegistry.artifactOrigin(runId, artifactId);
      const execution = remoteExecution(workspaceManager, origin.run.execution);
      if (!execution) {
        return Boolean(runRegistry.requireArtifact(runId, artifactId));
      }
      const result = await workspaceManager.execute(execution.workspaceId, execution.executionDeviceId, 'executor.artifact', {
        runId: origin.run.id, artifactId: origin.artifactId, metadata: true, offset: 0, length: 1,
      }) as { available?: boolean; data?: string };
      // Older peers return bytes instead of metadata for an existing file.
      return result.available ?? (typeof result.data === 'string' ? true : undefined);
    },
    artifact: async (runId, artifactId, reply, inline) => {
      const run = runRegistry.require(runId); const origin = runRegistry.artifactOrigin(runId, artifactId); const e = remoteExecution(workspaceManager, origin.run.execution);
      if (!e) { return false; }
      const artifact = run.artifacts?.find(a => a.id === artifactId);
      if (!artifact) { throw MarifoldError.artifactNotFound(runId, artifactId); }
      artifactHeaders(reply, artifact, inline);
      await remoteArtifactDownload(reply, artifactTransfers, artifact.size, e.workspaceId, input =>
        workspaceManager.execute(e.workspaceId, e.executionDeviceId, 'executor.artifact', {
          runId: origin.run.id, artifactId: origin.artifactId, ...input,
        }));
      return true;
    },
  });
  registerProfileRoutes(server, runtime, {
    isProfileActive: profile =>
      (activeProfileRequests.get(profile) ?? 0) > 0
      || runRegistry.list().some(run => run.profile === profile && run.finishedAt === undefined),
  });

  registerWorkspaceRoutes(server, workspaceManager, runRegistry, workspaceContext, (operation, input, context) => workspaceExecutor.handle(operation, input, context), security.token, id => { workspaceExecutor.cancelWorkspace(id); artifactTransfers.cancelWorkspace(id); }, artifactTickets, artifactTransfers);
  server.addHook('onClose', async () => workspaceExecutor.close());

  const webDir = resolveServiceWebDir(options);
  if (webDir) { registerStaticRoutes(server, webDir); }

  server.addHook('onClose', async () => {
    telegramBridge?.stop();
    scheduler?.stop();
    runRegistry.close();
    skillAppInstances.close();
    runtime.close();
  });

  server.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error, requestOrigin(request, workspaceContext.resolve(request.headers)) === 'local');
    if (normalized.statusCode >= 500) { request.log.error(error); }
    // A file download may fail after it set its headers (e.g. its device went
    // offline); the error itself is always JSON.
    reply.removeHeader('content-disposition');
    reply.removeHeader('content-length');
    reply.type('application/json; charset=utf-8');
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

  server.post<{ Params: { operation: string } }>('/v1/terminal/:operation', async request => ({ ok: true, result: await workspaceTerminal(runtime, request.params.operation, request.body ?? {}) }));

  let revision = 0; const generation = `${Date.now()}-${Math.random()}`;
  const unsubscribeChanges = runRegistry.subscribe(() => { revision++; });
  server.get('/v1/changes', async () => ({ ok: true, revision: `${generation}:${revision}` }));
  server.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400 && request.method !== 'GET' && request.method !== 'HEAD'
      && !request.url.startsWith('/v1/workspaces') && !['/v1/skills/resolve', '/v1/terminal/snapshot'].includes(request.url)) { revision++; }
  });
  server.addHook('onClose', async () => unsubscribeChanges());

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

  registerConfigRoutes(server, runtime, options, security);

  registerSkillAppRoutes(server, runtime, skillAppInstances);

  registerSessionRoutes(server, runtime, runRegistry, { hasActiveSessionRequest, beginSessionRequest });

  registerChatRoutes(server, runtime, options, workspaceContext, beginSessionRequest);

  registerWorkspaceScheduleRoutes(server, runtime);
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

  registerTaskRoutes(server, runtime);

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

