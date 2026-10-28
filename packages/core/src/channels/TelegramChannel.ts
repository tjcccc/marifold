import type { LoadedMarifoldConfig, TelegramChannelConfig } from '../config/ConfigSchema';
import { ConfigManager } from '../config/ConfigManager';
import { MarifoldError } from '../errors/MarifoldError';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import { TelegramBridge, type TelegramBridgeStatus } from './TelegramBridge';

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;

/** Where the bot token comes from. The token itself never leaves the process. */
export type TelegramTokenSource =
  | { source: 'config' }
  | { source: 'env'; env: string; set: boolean }
  | { source: 'missing' };

/** Why the bridge is or is not running. `restarting` waits for the current reply. */
export type TelegramChannelState = 'polling' | 'restarting' | 'off' | 'no-token' | 'not-configured';

/** Sanitized `[channel.telegram]` plus live bridge health. */
export interface TelegramChannelView {
  configured: boolean;
  enabled: boolean;
  profile: string;
  allowlist: number[];
  proxy?: string;
  token: TelegramTokenSource;
  state: TelegramChannelState;
  bridge?: TelegramBridgeStatus;
}

/** A partial settings change. `botToken` is write-only; `proxy: ''` clears it. */
export interface TelegramChannelUpdate {
  enabled?: boolean;
  profile?: string;
  allowlist?: number[];
  proxy?: string;
  botToken?: string;
}

export interface TelegramChannelDeps {
  runtime: MarifoldRuntime;
  loadedConfig: LoadedMarifoldConfig;
  log?: (message: string) => void;
  /** Injectable for tests. */
  createBridge?: (token: string, config: TelegramChannelConfig) => TelegramBridge;
}

/**
 * Owns the service's Telegram bridge: starts it from `[channel.telegram]`,
 * applies settings edits, and reports health. Profile, allowlist and proxy are
 * edited in place on the config object the bridge reads, so they apply at
 * once; a token or on/off change restarts the bridge, after the current reply
 * when one is in progress.
 */
export class TelegramChannel {
  private bridge?: TelegramBridge;
  private bridgeToken?: string;
  private restartPending = false;
  private stopped = false;

  constructor(private readonly deps: TelegramChannelDeps) {}

  /** Profile of the running bridge, for the service's startup report. */
  get activeProfile(): string | undefined {
    return this.bridge ? this.config()?.profile : undefined;
  }

  start(): void {
    this.stopped = false;
    const config = this.config();
    if (config && config.enabled !== false && !this.resolveToken(config)) {
      this.deps.log?.(`Telegram channel configured but no bot token resolved${config.botTokenEnv ? ` (env ${config.botTokenEnv} unset)` : ''} — bridge not started.`);
    }
    this.apply();
  }

  stop(): void {
    this.stopped = true;
    this.bridge?.stop();
    this.bridge = undefined;
    this.bridgeToken = undefined;
  }

  view(): TelegramChannelView {
    const config = this.config();
    const token: TelegramTokenSource = config?.botTokenEnv
      ? { source: 'env', env: config.botTokenEnv, set: Boolean(process.env[config.botTokenEnv]) }
      : config?.botToken ? { source: 'config' } : { source: 'missing' };
    return {
      configured: config !== undefined,
      enabled: config?.enabled !== false,
      profile: config?.profile ?? this.deps.loadedConfig.config.default.profile,
      allowlist: [...(config?.allowlist ?? [])],
      ...(config?.proxy ? { proxy: config.proxy } : {}),
      token,
      state: this.state(config),
      ...(this.bridge ? { bridge: this.bridge.status() } : {}),
    };
  }

  update(input: TelegramChannelUpdate): TelegramChannelView {
    const change = this.validate(input);
    const loaded = this.deps.loadedConfig.config;
    const config = loaded.channels?.telegram ?? {
      allowlist: [],
      profile: loaded.default.profile,
      defaultMode: 'agent' as const,
    };
    // Edit in place: a running bridge holds this object.
    if (change.enabled !== undefined) {
      if (change.enabled) { delete config.enabled; } else { config.enabled = false; }
    }
    if (change.profile !== undefined) { config.profile = change.profile; }
    if (change.allowlist !== undefined) { config.allowlist = change.allowlist; }
    if (change.proxy !== undefined) {
      if (change.proxy) { config.proxy = change.proxy; } else { delete config.proxy; }
    }
    if (change.botToken !== undefined) {
      config.botToken = change.botToken;
      delete config.botTokenEnv; // a pasted token replaces an env source, as `channel telegram setup` does
    }
    loaded.channels = { ...(loaded.channels ?? {}), telegram: config };
    new ConfigManager(this.deps.loadedConfig).save();
    this.apply();
    return this.view();
  }

  /** Send a test message to an allowlisted user (default: the first). */
  async sendTest(userId?: number): Promise<{ userId: number }> {
    const config = this.config();
    const target = userId ?? config?.allowlist[0];
    if (target === undefined || !config?.allowlist.includes(target)) {
      throw MarifoldError.configInvalid('Add a Telegram user id to the allowlist first; test messages go to allowlisted users only.');
    }
    if (!this.bridge) {
      throw MarifoldError.configInvalid('The Telegram bot is not running; set a bot token and turn it on first.');
    }
    try {
      await this.bridge.sendTest(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /chat not found/i.test(message) ? ' That user must open the bot in Telegram and send /start first.' : '';
      throw MarifoldError.channelError(`Telegram refused the test message: ${message}.${hint}`);
    }
    return { userId: target };
  }

  private config(): TelegramChannelConfig | undefined {
    return this.deps.loadedConfig.config.channels?.telegram;
  }

  private resolveToken(config: TelegramChannelConfig): string | undefined {
    return (config.botTokenEnv ? process.env[config.botTokenEnv] : config.botToken) || undefined;
  }

  private state(config: TelegramChannelConfig | undefined): TelegramChannelState {
    if (this.restartPending) { return 'restarting'; }
    if (this.bridge) { return 'polling'; }
    if (!config) { return 'not-configured'; }
    if (config.enabled === false) { return 'off'; }
    return 'no-token';
  }

  /** Bring the bridge in line with the config, waiting out a reply in progress. */
  private apply(): void {
    if (this.stopped) { return; }
    const config = this.config();
    const token = config && config.enabled !== false ? this.resolveToken(config) : undefined;
    if (token === this.bridgeToken) { return; }
    const current = this.bridge;
    if (current?.status().busy) {
      if (!this.restartPending) {
        this.restartPending = true;
        void current.whenIdle().then(() => {
          this.restartPending = false;
          this.apply();
        });
      }
      return;
    }
    current?.stop();
    this.bridge = undefined;
    this.bridgeToken = undefined;
    if (!config || !token) { return; }
    this.bridge = this.deps.createBridge?.(token, config) ?? new TelegramBridge({
      runtime: this.deps.runtime,
      token,
      config,
      log: this.deps.log,
      profilesDir: this.deps.loadedConfig.config.paths.profilesDir,
    });
    this.bridgeToken = token;
    this.bridge.start();
  }

  private validate(input: TelegramChannelUpdate): TelegramChannelUpdate {
    const change: TelegramChannelUpdate = {};
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') { throw MarifoldError.configInvalid('enabled must be true or false.'); }
      change.enabled = input.enabled;
    }
    if (input.profile !== undefined) {
      const profile = typeof input.profile === 'string' ? input.profile.trim() : '';
      if (!this.deps.runtime.listProfiles().some(entry => entry.name === profile)) {
        throw MarifoldError.configInvalid(`Unknown profile: ${profile || '(empty)'}.`);
      }
      change.profile = profile;
    }
    if (input.allowlist !== undefined) {
      if (!Array.isArray(input.allowlist) || !input.allowlist.every(id => Number.isSafeInteger(id) && id > 0)) {
        throw MarifoldError.configInvalid('allowlist must be a list of positive Telegram user ids.');
      }
      change.allowlist = [...new Set(input.allowlist)];
    }
    if (input.proxy !== undefined) {
      const proxy = typeof input.proxy === 'string' ? input.proxy.trim() : undefined;
      if (proxy === undefined) { throw MarifoldError.configInvalid('proxy must be a URL or empty.'); }
      if (proxy) {
        let protocol = '';
        try { protocol = new URL(proxy).protocol; } catch { /* reported below */ }
        if (protocol !== 'http:' && protocol !== 'https:') {
          throw MarifoldError.configInvalid('proxy must be an http:// or https:// URL, e.g. http://127.0.0.1:7890.');
        }
      }
      change.proxy = proxy;
    }
    if (input.botToken !== undefined) {
      const token = typeof input.botToken === 'string' ? input.botToken.trim() : '';
      // Never echo the value back: the message is safe to show and log.
      if (!BOT_TOKEN_PATTERN.test(token)) {
        throw MarifoldError.configInvalid('That does not look like a bot token from @BotFather (digits, a colon, then letters and digits).');
      }
      change.botToken = token;
    }
    return change;
  }
}
