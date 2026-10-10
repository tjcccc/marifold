import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createImagePreview, MarifoldError, type MarifoldRuntime, prepareImageInputs, type RunRegistry } from '@marifold/core';
import { nonNegativeIntegerPath, objectBody, parseBooleanQuery, parseLimitQuery, requiredString } from './Validation';

/** Session listing, transcripts, leases, attachments, and history edits. */
export function registerSessionRoutes(
  server: FastifyInstance,
  runtime: MarifoldRuntime,
  runRegistry: RunRegistry,
  sessionRequests: {
    hasActiveSessionRequest: (sessionId: string) => boolean;
    beginSessionRequest: (sessionId?: string, profile?: string) => () => void;
  },
): void {
  const { hasActiveSessionRequest, beginSessionRequest } = sessionRequests;
  server.get<{ Querystring: { limit?: string; profile?: string; archived?: string; q?: string } }>('/v1/sessions', async request => ({
    ok: true,
    sessions: runtime.listSessions(
      parseLimitQuery(request.query.limit) ?? 50,
      request.query.profile,
      {
        archived: parseBooleanQuery(request.query.archived),
        ...(request.query.q?.trim() ? { search: request.query.q } : {}),
        ...(request.sessionOwner ? { sessionOwner: request.sessionOwner } : {}),
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

  server.post<{ Params: { id: string } }>('/v1/sessions/:id/lease', async request => {
    const owner = request.sessionOwner;
    if (!owner) { throw MarifoldError.configInvalid('The client app (x-marifold-session-owner) is required.'); }
    // `takeover` moves a session held by another app or device here.
    if ((request.body as { takeover?: unknown } | undefined)?.takeover === true) { runtime.takeOverSession(request.params.id, owner); }
    else { runtime.acquireSession(request.params.id, owner); }
    return { ok: true };
  });
  server.delete<{ Params: { id: string } }>('/v1/sessions/:id/lease', async request => {
    if (request.sessionOwner) { runtime.releaseSession(request.params.id, request.sessionOwner); }
    return { ok: true };
  });
  server.addHook('preHandler', async request => {
    const body = request.body as { sessionId?: unknown } | undefined;
    const route = request.routeOptions.url ?? '';
    const sessionId = ['/v1/ask', '/v1/chat/stream', '/v1/runs'].includes(route) && typeof body?.sessionId === 'string'
      ? body.sessionId
      : route.startsWith('/v1/sessions/:id') && !route.endsWith('/lease') ? (request.params as { id: string }).id : undefined;
    if (sessionId) {
      runtime.assertSessionAvailable(sessionId, request.sessionOwner ?? 'unclaimed-request');
    }
  });

  server.get<{
    Params: { id: string; userTurnIndex: string; attachmentIndex: string };
    Querystring: { thumbnail?: string };
  }>('/v1/sessions/:id/attachments/:userTurnIndex/:attachmentIndex', async (request, reply) => {
    if (request.query.thumbnail !== undefined && request.query.thumbnail !== '1') {
      throw MarifoldError.configInvalid('thumbnail must be 1 when supplied.');
    }
    const userTurnIndex = nonNegativeIntegerPath(request.params.userTurnIndex, 'userTurnIndex');
    const attachmentIndex = nonNegativeIntegerPath(request.params.attachmentIndex, 'attachmentIndex');
    let attachment = runtime.getSessionAttachment(request.params.id, userTurnIndex, attachmentIndex);
    if (attachment?.path) {
      try {
        const prepared = (await prepareImageInputs([{ path: attachment.path }], { optimize: false })).images[0]!;
        const data = prepared.data ?? (prepared.path ? (await readFile(prepared.path)).toString('base64') : undefined);
        attachment = { mediaType: prepared.mediaType ?? attachment.mediaType, data };
      } catch {
        attachment = undefined;
      }
    }
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
    const thumbnail = request.query.thumbnail === '1';
    const bytes = Buffer.from(attachment.data, 'base64');
    reply
      .type(thumbnail ? 'image/webp' : attachment.mediaType)
      .header('cache-control', 'private, max-age=60')
      .header('x-content-type-options', 'nosniff');
    return reply.send(thumbnail ? await createImagePreview(bytes) : bytes);
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
    const endRequest = beginSessionRequest(request.params.id, requiredString(body.profile, 'profile'));
    try {
    const result = await runtime.compactSession(request.params.id, {
      profile: requiredString(body.profile, 'profile'),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.think === 'boolean' ? { think: body.think } : {}),
    });
    return { ok: true, ...result };
    } finally { endRequest(); }
  });
}
