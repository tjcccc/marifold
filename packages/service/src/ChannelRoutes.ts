import type { FastifyInstance } from 'fastify';
import { MarifoldError, type TelegramChannel, type TelegramChannelUpdate } from '@marifold/core';
import { objectBody } from './Validation';

const UPDATE_FIELDS = ['enabled', 'profile', 'allowlist', 'proxy', 'botToken'] as const;

/** This device's Telegram bot settings and health for its own Web UI. The bot
 * token is write-only: responses report only where it comes from.
 * `workspaceApiPath` keeps these routes off the workspace bridge. */
export function registerChannelRoutes(server: FastifyInstance, telegram: TelegramChannel): void {
  server.get('/v1/channels/telegram', async () => ({ ok: true, telegram: telegram.view() }));

  server.patch('/v1/channels/telegram', async request => {
    const body = objectBody(request.body);
    const unknown = Object.keys(body).filter(key => !(UPDATE_FIELDS as readonly string[]).includes(key));
    if (unknown.length > 0) { throw MarifoldError.configInvalid(`Unknown Telegram setting: ${unknown.join(', ')}.`); }
    // Field types are checked by TelegramChannel.update.
    return { ok: true, telegram: telegram.update(body as TelegramChannelUpdate) };
  });

  server.post('/v1/channels/telegram/test', async request => {
    const body = request.body === undefined ? {} : objectBody(request.body);
    if (body.userId !== undefined && !Number.isSafeInteger(body.userId)) {
      throw MarifoldError.configInvalid('userId must be a Telegram user id.');
    }
    return { ok: true, ...(await telegram.sendTest(body.userId as number | undefined)) };
  });
}
