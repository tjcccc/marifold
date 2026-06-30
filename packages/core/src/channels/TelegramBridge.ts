import { createLinkedAbort } from '@priest-ai/core';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import type { ProfileMode, TelegramChannelConfig } from '../config/ConfigSchema';
import { proxyDispatcher } from '../util/proxy';
import { respond } from './respond';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LONG_POLL_SECONDS = 25;
const POLL_OVERHEAD_MS = 10_000; // client timeout beyond the server-side long-poll
const SEND_TIMEOUT_MS = 30_000;
const ERROR_BACKOFF_MS = 3_000;
const MAX_MESSAGE_CHARS = 4096; // Telegram's per-message limit

const USAGE = [
  'marifold bot — commands:',
  '/agent — agent mode (can use tools)',
  '/chat — plain chat mode (no tools)',
  '/new — start a fresh session',
  '/help — show this help',
].join('\n');

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramBridgeDeps {
  runtime: MarifoldRuntime;
  token: string;
  config: TelegramChannelConfig;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to global fetch (proxied via undici). */
  fetchImpl?: typeof fetch;
}

/**
 * Long-poll Telegram bridge, hosted inside `marifold service`. Reads messages
 * via getUpdates, runs the allowlisted sender's turn through `respond()` under
 * the configured profile (unattended — the profile's permissions govern), and
 * sends the reply back. Single-user / one-at-a-time: updates are handled
 * sequentially. Network calls go through the proxy (Telegram is often blocked).
 */
export class TelegramBridge {
  /** Profile the bot runs as — surfaced so the service can report it. */
  readonly profile: string;

  private readonly runtime: MarifoldRuntime;
  private readonly token: string;
  private readonly config: TelegramChannelConfig;
  private readonly log?: (message: string) => void;
  private readonly fetchImpl: typeof fetch;

  private readonly chatModes = new Map<number, ProfileMode>();
  private readonly chatEpoch = new Map<number, number>();
  private offset = 0;
  private running = false;
  private abort?: AbortController;

  constructor(deps: TelegramBridgeDeps) {
    this.runtime = deps.runtime;
    this.token = deps.token;
    this.config = deps.config;
    this.profile = deps.config.profile;
    this.log = deps.log;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.log?.(`Telegram bridge started (profile ${this.profile}, default ${this.config.defaultMode} mode, ${this.config.allowlist.length} allowed user(s)).`);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        for (const update of await this.getUpdates()) {
          if (!this.running) break;
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break; // aborted by stop()
        this.log?.(`Telegram poll error: ${errorMessage(error)}`);
        await this.sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  /** Route a single update. Public for testing; the loop is the only other
   * caller. Non-text messages and non-allowlisted senders are ignored. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat?.id;
    const fromId = message?.from?.id;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (chatId === undefined || !text) return;
    if (fromId === undefined || !this.config.allowlist.includes(fromId)) {
      this.log?.(`Ignored message from non-allowlisted user ${fromId ?? '?'}`);
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
      return;
    }
    await this.runTurn(chatId, text);
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const command = text.split(/\s+/, 1)[0].toLowerCase();
    switch (command) {
      case '/start':
      case '/help':
        await this.sendMessage(chatId, USAGE);
        return;
      case '/chat':
        this.chatModes.set(chatId, 'chat');
        await this.sendMessage(chatId, 'Switched to chat mode.');
        return;
      case '/agent':
        this.chatModes.set(chatId, 'agent');
        await this.sendMessage(chatId, 'Switched to agent mode.');
        return;
      case '/new':
        this.chatEpoch.set(chatId, (this.chatEpoch.get(chatId) ?? 0) + 1);
        await this.sendMessage(chatId, 'Started a new session.');
        return;
      default:
        await this.sendMessage(chatId, `Unknown command ${command}.\n\n${USAGE}`);
    }
  }

  private async runTurn(chatId: number, prompt: string): Promise<void> {
    const mode = this.chatModes.get(chatId) ?? this.config.defaultMode;
    const epoch = this.chatEpoch.get(chatId) ?? 0;
    const sessionId = epoch ? `tg-${chatId}-${epoch}` : `tg-${chatId}`;

    let reply: string;
    try {
      const result = await respond(this.runtime, { profile: this.profile, mode, prompt, sessionId });
      reply = result.text || '(no response)';
      if (!result.ok) reply = `⚠️ The run didn't complete.\n\n${reply}`;
      if (result.denied.length > 0) reply += `\n\n(Couldn't run: ${result.denied.join(', ')} — denied by this profile's permissions.)`;
    } catch (error) {
      this.log?.(`Telegram turn failed (chat ${chatId}): ${errorMessage(error)}`);
      reply = `⚠️ Error: ${errorMessage(error)}`;
    }
    await this.sendMessage(chatId, reply);
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset: this.offset, timeout: LONG_POLL_SECONDS },
      LONG_POLL_SECONDS * 1000 + POLL_OVERHEAD_MS,
    );
    return Array.isArray(result) ? result : [];
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of chunkText(text, MAX_MESSAGE_CHARS)) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk }, SEND_TIMEOUT_MS);
    }
  }

  private async call<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const link = createLinkedAbort(timeoutMs, this.abort?.signal);
    const init: Record<string, unknown> = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: link.signal,
    };
    const dispatcher = proxyDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;
    try {
      const response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, init as RequestInit);
      const data = await response.json() as TelegramResponse<T>;
      if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${response.status}`}`);
      return data.result as T;
    } finally {
      link.dispose();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** Split into Telegram-sized chunks, preferring newline boundaries. */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
