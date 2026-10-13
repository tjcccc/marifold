import { type JSONValue, type PriestConfig, PriestEngine } from '@priest-ai/core';
import { type ChatGptRefreshedTokens, refreshChatGptAccessToken } from '../config/ChatGptTokenRefresh';
import type { LoadedMarifoldConfig } from '../config/ConfigSchema';
import { exchangeGitHubTokenForCopilotToken } from '../config/GitHubCopilotAuth';
import { withOAuthCredentials } from '../config/OAuthCredentials';
import type { NativeWebSearchStrategy, ProviderFactory } from '../config/ProviderFactory';
import { ReasoningRetryProvider, reasoningRejected } from '../config/ReasoningRetry';
import { type ThinkTarget, supportsThink, thinkReasoning } from '../config/ThinkReasoning';
import { type XaiRefreshedTokens, refreshXaiAccessToken } from '../config/XaiTokenRefresh';
import { MarifoldError } from '../errors/MarifoldError';
import type { ProfileResolver } from '../profiles/ProfileResolver';
import type { SessionResolver } from '../sessions/SessionResolver';
import type { MarifoldResolvedSettings } from './MarifoldTypes';

const NATIVE_WEB_SEARCH_COMPAT_OPTION = 'marifold_native_web_search';

/**
 * Translates resolved marifold settings into Priest engines and request
 * config: provider adapters, OAuth credential refresh, and reasoning options.
 * Reads the loaded config on every call, so `config set` edits apply.
 */
export class ProviderEngines {
  constructor(
    private readonly loadedConfig: LoadedMarifoldConfig,
    private readonly providerFactory: ProviderFactory,
    private readonly profileResolver: ProfileResolver,
    private readonly sessionResolver: SessionResolver,
  ) {}

  create(providerName: string, useSession: boolean, profileContext = true): PriestEngine {
    const adapter = new ReasoningRetryProvider(this.providerFactory.create(providerName), providerName);
    const profileLoader = profileContext
      ? this.profileResolver
      : {
          load: (name: string) => ({
            name,
            identity: '',
            rules: '',
            custom: '',
            memories: [],
          }),
        };
    return new PriestEngine(
      profileLoader,
      useSession ? this.sessionResolver.openStore() : undefined,
      { [providerName]: adapter },
    );
  }

  async refreshCredentials(providerName: string): Promise<void> {
    if (providerName !== 'github_copilot' && providerName !== 'chatgpt' && providerName !== 'xai') { return; }

    await withOAuthCredentials(this.loadedConfig, providerName, async provider => {
      if (!provider.oauthToken) { return; }
      if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) { return; }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (provider.apiKey && provider.apiKeyExpiresAt !== undefined
        && provider.apiKeyExpiresAt > nowSeconds + 60) { return; }

      try {
        if (providerName === 'github_copilot') {
          const refreshed = await exchangeGitHubTokenForCopilotToken(provider.oauthToken);
          return { apiKey: refreshed.token, baseUrl: refreshed.baseUrl, apiKeyExpiresAt: refreshed.expiresAt };
        }
        if (providerName === 'xai') {
          const refreshed: XaiRefreshedTokens = await refreshXaiAccessToken(provider.oauthToken, provider.proxy);
          return { apiKey: refreshed.apiKey, oauthToken: refreshed.refreshToken, apiKeyExpiresAt: refreshed.expiresAt };
        }
        // Legacy ChatGPT credentials may be valid without a reported expiry.
        if (provider.apiKey && provider.apiKeyExpiresAt === undefined) { return; }
        const refreshed: ChatGptRefreshedTokens = await refreshChatGptAccessToken(provider.oauthToken, provider.proxy);
        return {
          apiKey: refreshed.apiKey, oauthToken: refreshed.refreshToken, apiKeyExpiresAt: refreshed.expiresAt,
          ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
        };
      } catch (error) {
        const label = providerName === 'xai' ? 'xAI' : providerName === 'chatgpt' ? 'ChatGPT' : 'GitHub Copilot';
        throw MarifoldError.configInvalid(
          `${label} authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Run marifold provider reauth ${providerName} to sign in again.`,
        );
      }
    });
  }

  priestConfig(
    settings: MarifoldResolvedSettings,
    nativeWebSearch: NativeWebSearchStrategy = 'none',
  ): PriestConfig {
    const { config } = this.loadedConfig;
    const providerOptions: Record<string, JSONValue> = {};
    // Compatibility bridge for Priest 3.0.x. Priest 3.1 reads providerTools
    // directly; Marifold's Responses wrapper consumes and removes this marker
    // when an older engine does not forward that additive request field.
    if (nativeWebSearch === 'responses-tool') {
      providerOptions[NATIVE_WEB_SEARCH_COMPAT_OPTION] = true;
    } else if (nativeWebSearch === 'chat-option') {
      providerOptions['enable_search'] = true;
    }
    return {
      provider: settings.provider,
      model: settings.model,
      timeoutSeconds: config.default.timeoutSeconds,
      maxOutputTokens: config.default.maxOutputTokens,
      maxSystemChars: config.default.maxSystemChars,
      maxContextTokens: settings.maxContextTokens ?? config.default.maxContextTokens,
      compactionKeepTurns: config.default.compactionKeepTurns,
      sessionContextTurns: settings.sessionContextTurns ?? config.default.sessionContextTurns,
      reasoning: thinkReasoning(this.thinkTarget(settings.provider, settings.model), settings.think),
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    };
  }

  supportsThink(providerName: string, model: string): boolean {
    return supportsThink(this.thinkTarget(providerName, model));
  }

  private thinkTarget(providerName: string, model: string): ThinkTarget {
    const providerType = this.loadedConfig.config.providers[providerName]?.type;
    return { providerName, providerType, model, rejected: reasoningRejected(providerName, model) };
  }
}
