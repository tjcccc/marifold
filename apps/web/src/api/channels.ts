import type { ApiClient } from './client';
import type { TelegramChannelUpdate, TelegramChannelView } from './types';

/** The serving device's Telegram bot. These routes never cross a workspace, so
 * pass the local client. The bot token is write-only. */
export async function getTelegramChannel(client: ApiClient): Promise<TelegramChannelView> {
  const response = await client.request<{ telegram: TelegramChannelView }>('GET', '/v1/channels/telegram');
  return response.telegram;
}

export async function updateTelegramChannel(client: ApiClient, update: TelegramChannelUpdate): Promise<TelegramChannelView> {
  const response = await client.request<{ telegram: TelegramChannelView }>('PATCH', '/v1/channels/telegram', update);
  return response.telegram;
}

export async function sendTelegramTest(client: ApiClient, userId: number): Promise<void> {
  await client.request('POST', '/v1/channels/telegram/test', { userId });
}
