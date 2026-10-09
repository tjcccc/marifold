import { type JSONValue, type PriestConfig, PriestEngine } from '@priest-ai/core';
import { type ChatGptRefreshedTokens, refreshChatGptAccessToken } from '../config/ChatGptTokenRefresh';
import type { LoadedMarifoldConfig } from '../config/ConfigSchema';
import { exchangeGitHubTokenForCopilotToken } from '../config/GitHubCopilotAuth';
import { withOAuthCredentials } from '../config/OAuthCredentials';
import type { NativeWebSearchStrategy, ProviderFactory } from '../config/ProviderFactory';
import { isGitHubCopilotResponsesModelId } from '../config/ProviderRegistry';
import { type XaiRefreshedTokens, refreshXaiAccessToken } from '../config/XaiTokenRefresh';
import { MarifoldError } from '../errors/MarifoldError';
import type { ProfileResolver } from '../profiles/ProfileResolver';
import type { SessionResolver } from '../sessions/SessionResolver';
import type { MarifoldResolvedSettings } from './MarifoldTypes';

// Older OpenAI-compatible gateways still take a raw `{think}` body option.
// Priest 2.8 owns neutral reasoning for Ollama, Anthropic, and Responses.
const LEGACY_THINK_PROVIDER_NAMES = new Set(['bailian', 'alibaba_cloud']);
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
    const adapter = this.providerFactory.create(providerName);
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
        const refreshed: ChatGptRefreshedTokens = await refreshChatGptAccessToken(provider.oauthToken);
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
    const provider = config.providers[settings.provider];
    const neutralReasoning = this.supportsNeutralReasoning(settings.provider, settings.model);
    const providerOptions: Record<string, JSONValue> = {};
    if (LEGACY_THINK_PROVIDER_NAMES.has(settings.provider)) { providerOptions['think'] = settings.think; }
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
      reasoning: provider?.type === 'ollama'
        ? {
            enabled: settings.think,
            ...(settings.think ? { effort: 'high', summary: 'auto' as const } : {}),
          }
        : neutralReasoning && /^gpt-6-astra(?:-|$)/.test(settings.model)
          ? {
              enabled: true,
              effort: settings.think ? 'medium' : 'low',
              ...(settings.think ? { summary: 'auto' as const } : {}),
            }
          : neutralReasoning && settings.think
            ? { enabled: true, effort: 'high', summary: 'auto' }
            : undefined,
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    };
  }

  supportsThink(providerName: string, model: string): boolean {
    return LEGACY_THINK_PROVIDER_NAMES.has(providerName)
      || this.supportsNeutralReasoning(providerName, model);
  }

  private supportsNeutralReasoning(providerName: string, model: string): boolean {
    const provider = this.loadedConfig.config.providers[providerName];
    return provider?.type === 'ollama'
      || provider?.type === 'anthropic'
      || providerName === 'chatgpt'
      || (providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(model));
  }
}
