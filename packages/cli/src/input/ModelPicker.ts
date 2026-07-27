import {
  LoadedMarifoldConfig,
  MarifoldError,
  MarifoldProviderConfig,
  ProviderInspector,
  ProviderRegistryEntry,
  ProviderType,
  listProviderRegistry,
} from '@marifold/core';
import { authorizeChatGptWithBrowser } from '../auth/ChatGptAuth';
import { authorizeXaiWithBrowser } from '../auth/XaiAuth';
import {
  authorizeGitHubCopilotWithDevice,
  exchangeGitHubTokenForCopilotToken,
  looksLikeCopilotIdeToken,
} from '../auth/GitHubCopilotAuth';
import { InteractivePrompt } from './InteractivePrompt';
import { PromptAbortError } from './PromptAbort';
import { readSecretLine } from './SecretPrompt';
import { selectTerminalOption } from './TerminalSelect';
import { TerminalStyle } from '../output/TerminalStyle';

/** Lazily-created prompt, so an interactive picker only opens stdin when a
 * fallback line read is actually needed. Shared by `model add` and `init`. */
export type PromptFactory = () => InteractivePrompt;

/** The provider-setup flags `model add` accepts; the picker reads only these. */
export interface ModelAddSetupOptions {
  providerType?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

interface ProviderChoice {
  name: string;
  label: string;
  kind: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  isDefault: boolean;
  configured: boolean;
}

/**
 * Resolve a provider/model pair for `marifold model add` (and `marifold init`'s
 * model step). Falls back to interactive provider/model pickers when an argument
 * is omitted, prompting for OAuth credentials when the chosen provider needs them.
 */
export async function resolveModelAddTarget(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  providerArg?: string,
  modelArg?: string,
  options: ModelAddSetupOptions = {},
): Promise<{ provider: string; model: string }> {
  const providerWasPicked = providerArg === undefined;
  const provider = providerArg ?? await selectProvider(loadedConfig, getPrompt, style);
  if (providerWasPicked) process.stdout.write('\n');
  const shouldPromptProviderSetup = providerWasPicked || modelArg === undefined;
  if (shouldPromptProviderSetup) {
    await promptProviderSetupIfNeeded(loadedConfig, getPrompt, style, provider, options);
  }
  const model = modelArg ?? await selectModel(loadedConfig, getPrompt, style, provider);
  return { provider, model };
}

async function selectProvider(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
): Promise<string> {
  const providers = modelAddProviderChoices(loadedConfig);
  if (providers.length === 0) {
    throw MarifoldError.configInvalid('No providers are available. Run marifold init or pass provider/model explicitly.');
  }

  const defaultIndex = providers.findIndex(provider => provider.isDefault);
  const selected = await selectTerminalOption('Select provider:', providers.map(provider => ({
    label: formatProvider(provider),
    value: provider.name,
  })), {
    defaultIndex: defaultIndex >= 0 ? defaultIndex : 0,
  });
  if (selected !== undefined) return selected;

  process.stdout.write('Select provider:\n');
  providers.forEach((provider, index) => {
    process.stdout.write(`  ${index + 1}. ${formatProvider(provider)}\n`);
  });

  return readChoice(getPrompt(), style, 'Provider', providers.map(provider => provider.name), {
    defaultIndex: defaultIndex >= 0 ? defaultIndex : 0,
  });
}

async function selectModel(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: string,
): Promise<string> {
  const inspector = new ProviderInspector(loadedConfig);
  const result = await inspector.listModels(provider);
  const savedModels = savedModelsForProvider(loadedConfig, provider);
  const models = uniqueSorted([...result.models, ...savedModels]);

  if (models.length > 0) {
    process.stdout.write(style.dim(`${result.message}\n`));
    const customValue = Symbol('custom model');
    const selected = await selectTerminalOption<string | typeof customValue>(`Select model for ${provider}:`, [
      ...models.map(model => ({
        label: model,
        value: model,
      })),
      {
        label: 'Custom model...',
        value: customValue,
      },
    ], {
      defaultIndex: 0,
    });

    if (selected !== undefined) {
      if (selected === customValue) return readRequiredLine(getPrompt(), style, `Model for ${provider}: `);
      return selected;
    }

    process.stdout.write(`Select model for ${provider}:\n`);
    models.forEach((model, index) => {
      process.stdout.write(`  ${index + 1}. ${model}\n`);
    });
    return readChoice(getPrompt(), style, 'Model', models, {
      defaultIndex: 0,
      allowCustom: true,
    });
  }

  if (result.message) process.stdout.write(style.dim(`${result.message}\n`));
  return readRequiredLine(getPrompt(), style, `Model for ${provider}: `);
}

/** Read a numbered choice (or custom name when allowed) from a text prompt —
 * the keyboard-less fallback when an arrow-key selector is unavailable. */
export async function readChoice(
  prompt: InteractivePrompt,
  style: TerminalStyle,
  label: string,
  values: string[],
  options: { defaultIndex?: number; allowCustom?: boolean } = {},
): Promise<string> {
  const defaultSuffix = options.defaultIndex !== undefined ? ` [${options.defaultIndex + 1}]` : '';
  const customSuffix = options.allowCustom ? ' (number or custom name)' : '';
  const answer = await prompt.readUserMessage(style.bold(`${label}${customSuffix}${defaultSuffix}: `));
  if (answer === undefined) throw new PromptAbortError();
  const raw = answer.trim();

  if (!raw && options.defaultIndex !== undefined) return values[options.defaultIndex];
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= values.length) return values[index - 1];
  if (options.allowCustom && raw) return raw;
  throw MarifoldError.configInvalid(`Invalid ${label.toLowerCase()} selection.`);
}

async function readRequiredLine(prompt: InteractivePrompt, style: TerminalStyle, label: string): Promise<string> {
  const answer = await prompt.readUserMessage(style.bold(label));
  if (answer === undefined) throw new PromptAbortError();
  const value = answer.trim();
  if (!value) throw MarifoldError.configInvalid(`${label.replace(/:\s*$/, '')} cannot be empty.`);
  return value;
}

function modelAddProviderChoices(loadedConfig: LoadedMarifoldConfig): ProviderChoice[] {
  const configured = loadedConfig.config.providers;
  const registry = listProviderRegistry();
  const registryNames = new Set(registry.map(provider => provider.name));
  const choices = registry.map(entry => providerChoiceFromRegistry(entry, loadedConfig));

  const extraConfigured = Object.entries(configured)
    .filter(([name]) => !registryNames.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, provider]) => ({
      name,
      label: name,
      kind: 'configured',
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      isDefault: name === loadedConfig.config.default.provider,
      configured: true,
    }));

  return [...choices, ...extraConfigured];
}

function providerChoiceFromRegistry(entry: ProviderRegistryEntry, loadedConfig: LoadedMarifoldConfig): ProviderChoice {
  const configured = loadedConfig.config.providers[entry.name];
  return {
    name: entry.name,
    label: entry.label,
    kind: entry.kind,
    type: configured?.type ?? entry.type,
    baseUrl: configured?.baseUrl ?? entry.defaultBaseUrl,
    apiKeyEnv: configured?.apiKeyEnv ?? entry.apiKeyEnv,
    isDefault: entry.name === loadedConfig.config.default.provider,
    configured: Boolean(configured),
  };
}

function formatProvider(provider: ProviderChoice): string {
  return `${provider.name}  —  ${provider.label}`;
}

async function promptProviderSetupIfNeeded(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: string,
  options: ModelAddSetupOptions,
): Promise<void> {
  const entry = listProviderRegistry().find(item => item.name === provider);
  if (entry?.kind !== 'oauth') return;
  if (providerHasUsableCredential(loadedConfig.config.providers[provider], options)) return;

  await reauthenticateOAuthProvider(loadedConfig, getPrompt, style, provider);
}

/** Force a fresh credential flow for a registry-managed OAuth provider while
 * preserving its non-credential settings (for example proxy and base URL). */
export async function reauthenticateOAuthProvider(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: string,
): Promise<MarifoldProviderConfig> {
  const entry = listProviderRegistry().find(item => item.name === provider);
  if (!entry) {
    throw MarifoldError.configInvalid(`Unknown provider '${provider}'.`);
  }
  if (entry.kind !== 'oauth') {
    throw MarifoldError.configInvalid(
      `Provider '${provider}' does not use Marifold-managed OAuth. Update its API key or API key environment variable instead.`,
    );
  }

  const credentials = await promptOAuthCredentials(getPrompt, style, entry);
  const current = loadedConfig.config.providers[provider] ?? { type: entry.type };
  const updated = applyOAuthCredentials(current, entry, credentials);
  loadedConfig.config.providers[provider] = updated;
  return updated;
}

/** Pure credential replacement used by setup and explicit re-authentication. */
export function applyOAuthCredentials(
  current: MarifoldProviderConfig,
  entry: ProviderRegistryEntry,
  credentials: Partial<MarifoldProviderConfig>,
): MarifoldProviderConfig {
  const updated: MarifoldProviderConfig = {
    ...current,
    type: entry.type,
    baseUrl: credentials.baseUrl ?? current.baseUrl ?? entry.defaultBaseUrl,
    apiKeyEnv: current.apiKeyEnv ?? entry.apiKeyEnv,
    apiKey: credentials.apiKey,
    oauthToken: credentials.oauthToken,
    apiKeyExpiresAt: credentials.apiKeyExpiresAt,
    accountId: credentials.accountId,
  };
  // Keep the in-memory config as clean as the serialized TOML: switching from
  // OAuth to a manual credential must not retain an obsolete refresh token,
  // expiry, or ChatGPT account id.
  if (!updated.apiKeyEnv) delete updated.apiKeyEnv;
  if (!updated.apiKey) delete updated.apiKey;
  if (!updated.oauthToken) delete updated.oauthToken;
  if (updated.apiKeyExpiresAt === undefined) delete updated.apiKeyExpiresAt;
  if (!updated.accountId) delete updated.accountId;
  return updated;
}

async function promptOAuthCredentials(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: ProviderRegistryEntry,
): Promise<Partial<MarifoldProviderConfig>> {
  if (provider.name === 'github_copilot') return promptGitHubCopilotCredentials(getPrompt, style, provider);
  if (provider.name === 'chatgpt') return promptChatGptCredentials(getPrompt, style, provider);
  if (provider.name === 'xai') return promptXaiCredentials(getPrompt, style, provider);

  const token = await readRequiredSecret(getPrompt, style, 'OAuth token: ');
  return {
    apiKey: token,
    baseUrl: provider.defaultBaseUrl,
  };
}

async function promptGitHubCopilotCredentials(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: ProviderRegistryEntry,
): Promise<Partial<MarifoldProviderConfig>> {
  const method = await selectLabeledChoice(getPrompt, style, 'GitHub Copilot authorization:', [
    { label: 'Authorize with GitHub device code (OAuth)', value: 'device' },
    { label: 'Paste token manually', value: 'manual' },
  ]);

  if (method === 'device') return authorizeGitHubCopilotWithDevice();

  const tokenType = await selectLabeledChoice(getPrompt, style, 'Token type:', [
    { label: 'GitHub OAuth/PAT token (exchange now)', value: 'github' },
    { label: 'Copilot IDE token (starts with tid=)', value: 'copilot' },
  ]);
  const token = await readRequiredSecret(getPrompt, style, 'Token: ');

  if (tokenType === 'copilot') {
    if (!looksLikeCopilotIdeToken(token)) {
      process.stderr.write(style.yellow('Token does not look like a Copilot IDE token; saving it anyway.\n'));
    }
    return {
      apiKey: token,
      baseUrl: provider.defaultBaseUrl,
    };
  }

  const copilot = await exchangeGitHubTokenForCopilotToken(token);
  return {
    apiKey: copilot.token,
    baseUrl: copilot.baseUrl,
    oauthToken: token,
    apiKeyExpiresAt: copilot.expiresAt,
  };
}

async function promptChatGptCredentials(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: ProviderRegistryEntry,
): Promise<Partial<MarifoldProviderConfig>> {
  const method = await selectLabeledChoice(getPrompt, style, 'ChatGPT credential:', [
    { label: 'Sign in with ChatGPT in browser (OAuth)', value: 'oauth' },
    { label: 'Paste OpenAI API key', value: 'api_key' },
  ]);

  if (method === 'oauth') {
    const tokens = await authorizeChatGptWithBrowser();
    return {
      // The OAuth access token is the Codex-backend bearer credential; ChatGPT
      // subscription accounts have no platform API key to exchange for.
      apiKey: tokens.accessToken,
      baseUrl: provider.defaultBaseUrl,
      oauthToken: tokens.refreshToken,
      apiKeyExpiresAt: tokens.expiresAt,
      accountId: tokens.accountId,
    };
  }

  return {
    apiKey: await readRequiredSecret(getPrompt, style, 'OpenAI API key: '),
    baseUrl: provider.defaultBaseUrl,
  };
}

async function promptXaiCredentials(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: ProviderRegistryEntry,
): Promise<Partial<MarifoldProviderConfig>> {
  // SuperGrok / X Premium+ subscription OAuth is the intended path. A raw key is
  // still honored via the XAI_API_KEY env var (apiKeyEnv), so the picker stays
  // OAuth-only rather than prompting for a key to store in config. The paste
  // callback lets the user finish when xAI shows a code instead of redirecting.
  const tokens = await authorizeXaiWithBrowser(
    text => process.stdout.write(text),
    async label => getPrompt().readUserMessage(style.bold(label)),
  );
  return {
    // api.x.ai is plain OpenAI-compatible: the OAuth access token is the Bearer
    // credential directly, refreshed from the stored refresh token.
    apiKey: tokens.accessToken,
    baseUrl: provider.defaultBaseUrl,
    oauthToken: tokens.refreshToken,
    apiKeyExpiresAt: tokens.expiresAt,
  };
}

async function selectLabeledChoice<T extends string>(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  message: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  const selected = await selectTerminalOption(message, options);
  if (selected !== undefined) return selected;

  process.stdout.write(`${message}\n`);
  options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option.label}\n`);
  });
  return readChoice(getPrompt(), style, message.replace(/:\s*$/, ''), options.map(option => option.value), {
    defaultIndex: 0,
  }) as Promise<T>;
}

async function readRequiredSecret(getPrompt: PromptFactory, style: TerminalStyle, label: string): Promise<string> {
  const value = await readSecretLine(style.bold(label), getPrompt);
  if (!value) throw MarifoldError.configInvalid(`${label.replace(/:\s*$/, '')} cannot be empty.`);
  return value;
}

export function providerHasUsableCredential(
  provider: MarifoldProviderConfig | undefined,
  options: ModelAddSetupOptions,
): boolean {
  if (options.apiKeyEnv) return true;
  if (!provider) return false;
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
  if (provider.apiKey) {
    const refreshWindowSeconds = 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return provider.apiKeyExpiresAt === undefined
      || provider.apiKeyExpiresAt > nowSeconds + refreshWindowSeconds;
  }
  return false;
}

function savedModelsForProvider(loadedConfig: LoadedMarifoldConfig, provider: string): string[] {
  return loadedConfig.config.models.options
    .filter(option => option.startsWith(`${provider}/`))
    .map(option => option.slice(provider.length + 1))
    .filter(model => model.length > 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
