import { FastifyInstance, FastifyReply } from 'fastify';
import { MarifoldError, RunApprovalAction, RunRegistry, RunStartInput } from '@marifold/core';
import { SSE_HEADERS, startSseHeartbeat, writeSse, writeSseRetry } from './Sse';
import {
  objectBody,
  optionalBooleanField,
  optionalPositiveIntegerField,
  optionalStringField,
  requiredString,
  stringArray,
} from './Validation';

const RECONNECT_DELAY_MS = 3000;

/**
 * Live agent-run routes over a RunRegistry: start, inspect, follow the
 * AgentEvent stream (SSE with seq ids + Last-Event-ID replay), answer
 * approvals, steer, and cancel. The AgentEvent union is serialized verbatim —
 * it is the wire contract shared with every other Marifold client.
 */
export function registerRunRoutes(server: FastifyInstance, registry: RunRegistry): void {
  server.post('/v1/runs', async (request, reply) => {
    const run = registry.start(parseRunStartInput(request.body));
    reply.status(201);
    return { ok: true, run };
  });

  server.get('/v1/runs', async () => ({ ok: true, runs: registry.list() }));

  server.get<{ Params: { id: string } }>('/v1/runs/:id', async request => ({
    ok: true,
    run: registry.require(request.params.id),
  }));

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
  return {
    objective: requiredString(body.objective, 'objective'),
    ...optionalStringField('profile', body.profile),
    ...optionalStringField('provider', body.provider),
    ...optionalStringField('model', body.model),
    ...optionalStringField('sessionId', body.sessionId),
    ...optionalStringField('cwd', body.cwd),
    ...optionalBooleanField('think', body.think),
    ...optionalBooleanField('forcePlan', body.forcePlan),
    ...optionalBooleanField('lean', body.lean),
    ...optionalPositiveIntegerField('maxIterations', body.maxIterations),
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
