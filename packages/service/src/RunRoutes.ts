import * as fs from 'fs';
import { ArtifactTickets, artifactHeaders } from './ArtifactTickets';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createArtifactPreview, isPreviewableArtifact, MarifoldError, RunApprovalAction, RunRegistry, RunStartInput } from '@marifold/core';
import { SSE_HEADERS, startSseHeartbeat, writeSse, writeSseRetry } from './Sse';
import {
  objectBody,
  optionalBooleanField,
  optionalImagesField,
  optionalNonNegativeIntegerField,
  optionalPositiveIntegerField,
  optionalRunFilesField,
  optionalStringField,
  requiredString,
  stringArray,
} from './Validation';

const RECONNECT_DELAY_MS = 3000;

/**
 * Live agent-run routes over a RunRegistry: start, inspect, follow the
 * AgentEvent stream (SSE with seq ids + Last-Event-ID replay), answer
 * clarifications, approvals, steer, and cancel. The AgentEvent union is serialized verbatim —
 * it is the wire contract shared with every other Marifold client.
 */
export function registerRunRoutes(server: FastifyInstance, registry: RunRegistry, options: {
  resolve?: (input: RunStartInput, body: Record<string, unknown>, request: FastifyRequest) => Promise<RunStartInput>;
  artifact?: (runId: string, artifactId: string, reply: FastifyReply, inline: boolean) => Promise<boolean>;
  tickets?: ArtifactTickets;
  preview?: (runId: string, artifactId: string) => Promise<Buffer | undefined>;
  artifactAvailable?: (runId: string, artifactId: string) => Promise<boolean | undefined>;
} = {}): void {
  server.post('/v1/runs', async (request, reply) => {
    const input = parseRunStartInput(request.body);
    const run = registry.start(options.resolve ? await options.resolve(input, objectBody(request.body), request) : input);
    reply.status(201);
    return { ok: true, run };
  });

  server.get<{ Querystring: { sessionId?: string } }>('/v1/runs', async request => ({
    ok: true, runs: registry.list(optionalStringField('sessionId', request.query.sessionId).sessionId),
  }));

  server.get<{ Params: { id: string } }>('/v1/runs/:id', async request => ({
    ok: true,
    run: registry.require(request.params.id),
  }));

  server.get<{ Params: { id: string } }>('/v1/runs/:id/artifacts', async request => {
    const run = registry.require(request.params.id);
    const artifacts = await Promise.all((run.artifacts ?? []).map(async artifact => {
      try {
        const available = options.artifactAvailable
          ? await options.artifactAvailable(run.id, artifact.id)
          : Boolean(registry.requireArtifact(run.id, artifact.id));
        return { ...artifact, available };
      } catch (error) {
        // A missing file is permanent until restored. A disconnected device or
        // network failure is unknown, so the download must remain retryable.
        return { ...artifact, available: error instanceof MarifoldError && error.code === 'ARTIFACT_NOT_FOUND' ? false : undefined };
      }
    }));
    return { ok: true, artifacts };
  });

  const sendArtifact = async (runId: string, artifactId: string, reply: FastifyReply, inline = false) => {
    if (await options.artifact?.(runId, artifactId, reply, inline)) return reply;
    const artifact = registry.requireArtifact(runId, artifactId);
    artifactHeaders(reply, artifact, inline);
    return reply.send(fs.createReadStream(artifact.path, { fd: fs.openSync(artifact.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), autoClose: true }));
  };
  server.get<{ Params: { id: string; artifactId: string } }>(
    '/v1/runs/:id/artifacts/:artifactId',
    (request, reply) => sendArtifact(request.params.id, request.params.artifactId, reply),
  );
  server.get<{ Params: { id: string; artifactId: string } }>(
    '/v1/runs/:id/artifacts/:artifactId/preview', async (request, reply) => {
      const { id, artifactId } = request.params;
      const bytes = await options.preview?.(id, artifactId) ?? await createArtifactPreview(registry.requireArtifact(id, artifactId));
      return reply.type('image/webp').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(bytes);
    },
  );
  if (options.tickets) server.post<{ Params: { id: string; artifactId: string } }>(
    '/v1/runs/:id/artifacts/:artifactId/access', async (request, reply) => {
      const { id, artifactId } = request.params;
      const artifact = registry.require(id).artifacts?.find(item => item.id === artifactId);
      if (!artifact) throw MarifoldError.artifactNotFound(id, artifactId);
      const purpose = objectBody(request.body).purpose;
      if (purpose !== 'download' && purpose !== 'image') throw MarifoldError.configInvalid('Invalid file access purpose.');
      if (purpose === 'image' && !isPreviewableArtifact(artifact.mediaType)) throw MarifoldError.configInvalid('This file is not a previewable image.');
      const available = options.artifactAvailable ? await options.artifactAvailable(id, artifactId) : Boolean(registry.requireArtifact(id, artifactId));
      if (available === false) throw MarifoldError.artifactNotFound(id, artifactId);
      reply.header('cache-control', 'no-store');
      return { ok: true, ...options.tickets!.issue(response => sendArtifact(id, artifactId, response, purpose === 'image')) };
    },
  );

  server.get<{ Params: { id: string }; Querystring: { after?: string; access_token?: string } }>(
    '/v1/runs/:id/events',
    async (request, reply) => {
      // Resolve 404s as JSON before the reply is hijacked for SSE.
      registry.require(request.params.id);
      const afterSeq = resolveAfterSeq(request.headers['last-event-id'], request.query.after);
      await streamRunEvents(reply, registry, request.params.id, afterSeq);
    },
  );

  server.post<{ Params: { id: string; requestId: string } }>(
    '/v1/runs/:id/approvals/:requestId',
    async request => {
      const action = parseApprovalAction(request.body);
      const result = registry.answerApproval(request.params.id, request.params.requestId, action);
      return { ok: true, ...result };
    },
  );

  server.post<{ Params: { id: string; requestId: string } }>(
    '/v1/runs/:id/inputs/:requestId',
    async request => {
      const result = registry.answerUserInput(
        request.params.id,
        request.params.requestId,
        objectBody(request.body),
      );
      return { ok: true, ...result };
    },
  );

  server.post<{ Params: { id: string } }>('/v1/runs/:id/steer', async (request, reply) => {
    const body = objectBody(request.body);
    registry.steer(request.params.id, requiredString(body.text, 'text'));
    reply.status(202);
    return { ok: true, queued: true };
  });

  server.post<{ Params: { id: string } }>('/v1/runs/:id/cancel', async (request, reply) => {
    const status = registry.cancel(request.params.id);
    reply.status(202);
    return { ok: true, status };
  });
}

async function streamRunEvents(
  reply: FastifyReply,
  registry: RunRegistry,
  runId: string,
  afterSeq: number,
): Promise<void> {
  let closed = false;
  const abort = new AbortController();
  reply.hijack();
  reply.raw.on('close', () => {
    closed = true;
    abort.abort();
  });
  reply.raw.writeHead(200, SSE_HEADERS);
  writeSseRetry(reply, RECONNECT_DELAY_MS);
  const stopHeartbeat = startSseHeartbeat(reply);

  try {
    for await (const { seq, event } of registry.events(runId, afterSeq, abort.signal)) {
      if (closed) break;
      writeSse(reply, event.type, event, seq);
    }
  } catch (error) {
    if (!closed) {
      writeSse(reply, 'error', {
        code: error instanceof MarifoldError ? error.code : 'STREAM_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    stopHeartbeat();
    if (!closed) reply.raw.end();
  }
}

function parseRunStartInput(value: unknown): RunStartInput {
  const body = objectBody(value);
  if (body.toolMode !== undefined && !['auto', 'native', 'control-block'].includes(String(body.toolMode))) throw MarifoldError.configInvalid('Invalid toolMode.');
  return {
    ...(body.toolMode !== undefined ? { toolMode: body.toolMode as RunStartInput['toolMode'] } : {}),
    objective: requiredString(body.objective, 'objective'),
    ...optionalStringField('profile', body.profile),
    ...optionalStringField('provider', body.provider),
    ...optionalStringField('model', body.model),
    ...optionalStringField('sessionId', body.sessionId),
    ...optionalStringField('userTurn', body.userTurn),
    ...optionalNonNegativeIntegerField('replaceUserTurnIndex', body.replaceUserTurnIndex),
    ...optionalStringField('cwd', body.cwd),
    ...optionalBooleanField('think', body.think),
    ...optionalBooleanField('originalImages', body.originalImages),
    ...optionalBooleanField('forcePlan', body.forcePlan),
    ...optionalBooleanField('lean', body.lean),
    ...optionalPositiveIntegerField('maxIterations', body.maxIterations),
    ...optionalImagesField(body.images),
    ...optionalRunFilesField(body.files),
    ...(body.instructions !== undefined ? { instructions: stringArray(body.instructions, 'instructions') } : {}),
  };
}

function parseApprovalAction(value: unknown): RunApprovalAction {
  const body = objectBody(value);
  const action = requiredString(body.action, 'action');
  if (action === 'once' || action === 'always' || action === 'trust' || action === 'deny') return action;
  throw MarifoldError.configInvalid('action must be one of "once", "always", "trust", or "deny".');
}

/** The Last-Event-ID header (an EventSource reconnect) wins over ?after. */
function resolveAfterSeq(header: string | string[] | undefined, after: string | undefined): number {
  const raw = typeof header === 'string' && header !== '' ? header : after;
  if (raw === undefined || raw === '') return 0;
  const seq = Number.parseInt(raw, 10);
  if (!Number.isInteger(seq) || seq < 0) {
    throw MarifoldError.configInvalid('after / Last-Event-ID must be a non-negative integer sequence number.');
  }
  return seq;
}
