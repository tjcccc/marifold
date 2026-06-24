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

  const credentials = await promptOAuthCredentials(getPrompt, style, entry);
  const current = loadedConfig.config.providers[provider] ?? { type: entry.type };
  loadedConfig.config.providers[provider] = {
    ...current,
    type: entry.type,
    baseUrl: credentials.baseUrl ?? current.baseUrl ?? entry.defaultBaseUrl,
    apiKeyEnv: current.apiKeyEnv ?? entry.apiKeyEnv,
    apiKey: credentials.apiKey,
    oauthToken: credentials.oauthToken,
    apiKeyExpiresAt: credentials.apiKeyExpiresAt,
  };
}

async function promptOAuthCredentials(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  provider: ProviderRegistryEntry,
): Promise<Partial<MarifoldProviderConfig>> {
  if (provider.name === 'github_copilot') return promptGitHubCopilotCredentials(getPrompt, style, provider);
  if (provider.name === 'chatgpt') return promptChatGptCredentials(getPrompt, style, provider);

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
      apiKey: tokens.apiKey ?? tokens.accessToken,
      baseUrl: provider.defaultBaseUrl,
      oauthToken: tokens.refreshToken,
      apiKeyExpiresAt: tokens.expiresAt,
    };
  }

  return {
    apiKey: await readRequiredSecret(getPrompt, style, 'OpenAI API key: '),
    baseUrl: provider.defaultBaseUrl,
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

function providerHasUsableCredential(provider: MarifoldProviderConfig | undefined, options: ModelAddSetupOptions): boolean {
  if (options.apiKeyEnv) return true;
  if (!provider) return false;
  if (provider.apiKey) return true;
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
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
