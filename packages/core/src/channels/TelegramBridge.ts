import { randomUUID } from 'crypto';
import { dirname, resolve, sep } from 'path';
import { createLinkedAbort } from '@priest-ai/core';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import type { ProfileMode, TelegramChannelConfig } from '../config/ConfigSchema';
import type { ApprovalDecision, ApprovalRequest, ToolKind } from '../agent/ApprovalPolicy';
import { proxyDispatcher } from '../util/proxy';
import { respond } from './respond';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LONG_POLL_SECONDS = 25;
const POLL_OVERHEAD_MS = 10_000; // client timeout beyond the server-side long-poll
const SEND_TIMEOUT_MS = 30_000;
const ERROR_BACKOFF_MS = 3_000;
const MAX_MESSAGE_CHARS = 4096; // Telegram's per-message limit
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // auto-deny if the user never taps

const USAGE = [
  'marifold bot — commands:',
  '/agent — agent mode (can use tools; asks before risky ones)',
  '/chat — plain chat mode (no tools)',
  '/new — start a fresh session',
  '/help — show this help',
].join('\n');

/** The tap a user made on an approval prompt (plus the synthetic 'timeout'). */
type ApprovalAction = 'once' | 'trust' | 'always' | 'deny' | 'timeout';

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: { id?: number };
    data?: string;
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
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
 * the configured profile, and sends the reply back. **Attended in agent mode:**
 * tool approvals prompt the user with inline buttons and the run waits for the
 * tap. Single-user / one-turn-at-a-time. Network calls go through the proxy
 * (Telegram is often blocked).
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
  // Session grants (mirror the TUI): once the user chooses "always"/"trust" we
  // stop re-prompting for that kind/folder for the bridge's lifetime.
  private readonly grantedKinds = new Set<ToolKind>();
  private readonly trustedFolders: string[] = [];
  private offset = 0;
  private running = false;
  private busy = false; // one text turn at a time
  private pendingApproval?: { token: string; resolve: (action: ApprovalAction) => void };
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
          // Detached: a turn may block on an approval whose callback_query only
          // arrives via a later getUpdates — awaiting here would deadlock.
          void this.handleUpdate(update).catch(error => this.log?.(`Telegram update error: ${errorMessage(error)}`));
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
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

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

    if (this.busy) {
      await this.sendMessage(chatId, '⏳ Still working on your previous message — one at a time.');
      return;
    }
    this.busy = true;
    try {
      await this.runTurn(chatId, text);
    } finally {
      this.busy = false;
    }
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
      const result = await respond(this.runtime, {
        profile: this.profile,
        mode,
        prompt,
        sessionId,
        // Agent tool approvals prompt the user via Telegram buttons; chat has none.
        approvalHandler: mode === 'agent' ? (request => this.requestApproval(chatId, request)) : undefined,
      });
      reply = result.text || '(no response)';
      if (!result.ok) reply = `⚠️ The run didn't complete.\n\n${reply}`;
      if (result.denied.length > 0) reply += `\n\n(Couldn't run: ${result.denied.join(', ')} — denied.)`;
    } catch (error) {
      this.log?.(`Telegram turn failed (chat ${chatId}): ${errorMessage(error)}`);
      reply = `⚠️ Error: ${errorMessage(error)}`;
    }
    await this.sendMessage(chatId, reply);
  }

  // ── Approval over Telegram ────────────────────────────────────────────────

  /** ApprovalHandler: prompt the user with inline buttons and wait for the tap.
   * "Always"/"Trust" also persist to the profile (future runs) and to the
   * session (no re-prompt this run). */
  private async requestApproval(chatId: number, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!request.escalated && this.grantedKinds.has(request.kind)) return { approved: true };
    if (request.escalated && request.escalatedPath && isInsideAny(request.escalatedPath, this.trustedFolders)) {
      return { approved: true };
    }

    const token = randomUUID();
    const alwaysButton = request.escalatedPath
      ? { text: '🛡 Trust folder', callback_data: `appr:${token}:trust` }
      : { text: `🛡 Always allow ${request.kind}`, callback_data: `appr:${token}:always` };
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [{ text: '✅ Allow once', callback_data: `appr:${token}:once` }],
        [alwaysButton],
        [{ text: '❌ Deny', callback_data: `appr:${token}:deny` }],
      ],
    };
    const promptText = `🔧 The agent wants to run:\n${request.summary}\n(${request.tool} · ${request.kind})`;
    // Register the waiter before sending, so a fast callback_query can't arrive
    // before pendingApproval is set.
    const approval = this.awaitApproval(token);
    const messageId = await this.sendMessage(chatId, promptText, keyboard);

    const action = await approval;
    await this.finalizeApprovalMessage(chatId, messageId, promptText, action);

    switch (action) {
      case 'deny':
        return { approved: false, reason: 'denied via Telegram' };
      case 'timeout':
        return { approved: false, reason: 'no response to the approval prompt' };
      case 'trust': {
        const folder = dirname(request.escalatedPath as string);
        if (!this.trustedFolders.includes(folder)) this.trustedFolders.push(folder);
        try {
          this.runtime.addProfileTrustedFolder(this.profile, folder);
        } catch (error) {
          this.log?.(`Could not persist trusted folder: ${errorMessage(error)}`);
        }
        return { approved: true };
      }
      case 'always':
        this.grantedKinds.add(request.kind);
        try {
          this.runtime.setProfileAgentApproval(this.profile, request.kind, 'allow');
        } catch (error) {
          this.log?.(`Could not persist approval: ${errorMessage(error)}`);
        }
        return { approved: true };
      default: // 'once'
        return { approved: true };
    }
  }

  private awaitApproval(token: string): Promise<ApprovalAction> {
    return new Promise<ApprovalAction>(resolveAction => {
      const timer = setTimeout(() => {
        if (this.pendingApproval?.token === token) {
          this.pendingApproval = undefined;
          resolveAction('timeout');
        }
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApproval = {
        token,
        resolve: action => {
          clearTimeout(timer);
          resolveAction(action);
        },
      };
    });
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const fromId = callback.from?.id;
    // Ack the tap so Telegram clears the button's spinner (best-effort).
    void this.call('answerCallbackQuery', { callback_query_id: callback.id }, SEND_TIMEOUT_MS).catch(() => undefined);
    if (fromId === undefined || !this.config.allowlist.includes(fromId)) return;

    const [, token, action] = (callback.data ?? '').split(':');
    const pending = this.pendingApproval;
    if (pending && pending.token === token && isApprovalAction(action)) {
      this.pendingApproval = undefined;
      pending.resolve(action);
    }
  }

  private async finalizeApprovalMessage(
    chatId: number,
    messageId: number | undefined,
    promptText: string,
    action: ApprovalAction,
  ): Promise<void> {
    if (messageId === undefined) return;
    const label =
      action === 'deny' ? '❌ Denied'
      : action === 'timeout' ? '⌛ No response — denied'
      : action === 'trust' ? '🛡 Trusted this folder — allowed'
      : action === 'always' ? '🛡 Always allowed'
      : '✅ Allowed once';
    // Replace the buttons with the outcome (best-effort — a stale edit is harmless).
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${promptText}\n\n→ ${label}`,
    }, SEND_TIMEOUT_MS).catch(() => undefined);
  }

  // ── Telegram transport ────────────────────────────────────────────────────

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset: this.offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
      LONG_POLL_SECONDS * 1000 + POLL_OVERHEAD_MS,
    );
    return Array.isArray(result) ? result : [];
  }

  /** Send text (chunked at Telegram's limit). Returns the message id carrying the
   * optional inline keyboard (attached to the final chunk), for later editing. */
  private async sendMessage(chatId: number, text: string, replyMarkup?: InlineKeyboard): Promise<number | undefined> {
    const chunks = chunkText(text, MAX_MESSAGE_CHARS);
    let keyboardMessageId: number | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const params: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      const isLast = i === chunks.length - 1;
      if (replyMarkup && isLast) params.reply_markup = replyMarkup;
      const sent = await this.call<{ message_id?: number }>('sendMessage', params, SEND_TIMEOUT_MS);
      if (replyMarkup && isLast) keyboardMessageId = sent?.message_id;
    }
    return keyboardMessageId;
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
    return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
  }
}

function isApprovalAction(value: string): value is Exclude<ApprovalAction, 'timeout'> {
  return value === 'once' || value === 'trust' || value === 'always' || value === 'deny';
}

/** True when `target` is inside one of `folders` (or equals it). */
function isInsideAny(target: string, folders: string[]): boolean {
  const resolved = resolve(target);
  return folders.some(folder => {
    const base = resolve(folder);
    return resolved === base || resolved.startsWith(base + sep);
  });
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
