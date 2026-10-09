import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentUsage, LoadedMarifoldConfig, MarifoldRunRequest, MarifoldRuntime } from '@marifold/core';
import { requestEnvironment } from './RequestEnvironment';
import { normalizeError } from './ServiceErrors';
import { SSE_HEADERS, startSseHeartbeat, writeSse } from './Sse';
import {
  objectBody,
  optionalBooleanField,
  optionalImagesField,
  optionalNonNegativeIntegerField,
  optionalStringField,
  requiredString,
  stringArray,
} from './Validation';
import type { WorkspaceRequestContext } from './WorkspaceRequestContext';

/** One-shot chat requests outside the run registry: `/v1/ask` and the
 * non-resumable `/v1/chat/stream` SSE response. */
export function registerChatRoutes(
  server: FastifyInstance,
  runtime: MarifoldRuntime,
  options: { loadedConfig: LoadedMarifoldConfig },
  workspaceContext: WorkspaceRequestContext,
  beginSessionRequest: (sessionId?: string, profile?: string) => () => void,
): void {
  server.post('/v1/ask', async request => {
    const input = { ...parseRunRequest(request.body), sessionOwner: typeof request.headers['x-marifold-session-owner'] === 'string' ? request.headers['x-marifold-session-owner'] : undefined, environment: requestEnvironment(request, workspaceContext.resolve(request.headers)) };
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
    const input = { ...parseRunRequest(request.body), sessionOwner: typeof request.headers['x-marifold-session-owner'] === 'string' ? request.headers['x-marifold-session-owner'] : undefined, environment: requestEnvironment(request, workspaceContext.resolve(request.headers)) };
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
        if (!closed) { writeSse(reply, 'reasoning', { text }); }
      },
    )) {
      if (closed) { break; }
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
    if (!closed) { reply.raw.end(); }
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
