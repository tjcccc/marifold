import { Command } from 'commander';
import {
  ConfigManager,
  LoadedMarifoldConfig,
  MarifoldProviderConfig,
  MarifoldError,
  ProfileManager,
  ProviderInspector,
  ProviderRegistryEntry,
  ProviderType,
  isKnownGitHubCopilotUnsupportedModelId,
  listProviderRegistry,
} from '@marifold/core';
import { authorizeChatGptWithBrowser } from '../auth/ChatGptAuth';
import {
  authorizeGitHubCopilotWithDevice,
  exchangeGitHubTokenForCopilotToken,
  looksLikeCopilotIdeToken,
} from '../auth/GitHubCopilotAuth';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { PromptAbortError, isPromptAbortError } from '../input/PromptAbort';
import { readSecretLine } from '../input/SecretPrompt';
import { selectTerminalOption } from '../input/TerminalSelect';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { createRuntime } from './RuntimeFactory';
import { loadConfig } from './RuntimeFactory';

interface ModelDefaultOptions {
  provider?: string;
  profile?: string;
  clear?: boolean;
}

interface ModelAddOptions {
  providerType?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  default?: boolean;
}

interface ModelValidateOptions {
  provider?: string;
  profile?: string;
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

type PromptFactory = () => InteractivePrompt;

const ADD_NEW_MODEL = '__marifold_add_new_model__';
const USE_GLOBAL_DEFAULT = '__marifold_use_global_default__';

export function registerModelCommand(program: Command, printer: ConsolePrinter): void {
  const model = program
    .command('model')
    .description('Inspect and update default model settings.')
    .action(() => {
      try {
        const { config } = loadConfig(program);
        process.stdout.write(`Current model: ${config.default.provider ?? 'unset'}/${config.default.model ?? 'unset'}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  model
    .command('list')
    .description('List saved provider/model options.')
    .action(() => {
      try {
        const { config } = loadConfig(program);
        const options = normalizedModelOptions(config.models.options, config.default.provider, config.default.model);
        if (options.length === 0) {
          process.stdout.write('No saved model options.\n');
          return;
        }
        for (const option of options) {
          const marker = option === `${config.default.provider}/${config.default.model}` ? '*' : ' ';
          process.stdout.write(`${marker} ${option}\n`);
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  model
    .command('validate')
    .description('Validate a provider/model pair against configured provider access.')
    .argument('[model]', 'Provider/model pair, or model name when --provider is set. Defaults to the resolved default model.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--profile <name>', 'Resolve the model through this profile.')
    .action(async (modelArg: string | undefined, options: ModelValidateOptions) => {
      let runtime: ReturnType<typeof createRuntime> | undefined;
      try {
        runtime = createRuntime(program);
        const loadedConfig = loadConfig(program);
        const resolved = resolveModelValidationTarget(runtime, modelArg, options);
        const result = await new ProviderInspector(loadedConfig).validateModel(resolved.provider, resolved.model);
        process.stdout.write(`${result.status.toUpperCase()} ${result.provider}/${result.model}: ${result.message}\n`);
        if (!result.valid) process.exitCode = 1;
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime?.close();
      }
    });

  model
    .command('add')
    .description('Add a provider/model option to config.')
    .argument('[provider]', 'Provider key. Omit for an interactive provider picker.')
    .argument('[model]', 'Model name. Omit for an interactive model picker when provider model listing is available.')
    .option('--provider-type <type>', 'Provider type: ollama, openai-compatible, or anthropic.')
    .option('--base-url <url>', 'Provider base URL.')
    .option('--api-key-env <name>', 'Environment variable containing the API key.')
    .option('--default', 'Also make this the global default model.')
    .action(async (providerArg: string | undefined, modelArg: string | undefined, options: ModelAddOptions) => {
      let prompt: InteractivePrompt | undefined;
      try {
        const loadedConfig = loadConfig(program);
        const style = new TerminalStyle();
        const getPrompt = (): InteractivePrompt => {
          prompt ??= new InteractivePrompt();
          return prompt;
        };
        const { provider, model: modelName } = await resolveModelAddTarget(
          loadedConfig,
          getPrompt,
          style,
          providerArg,
          modelArg,
          options,
        );
        assertCanSaveModelOption(provider, modelName);
        const manager = new ConfigManager(loadedConfig);
        const result = manager.addModel(provider, modelName, {
          type: parseProviderType(options.providerType),
          baseUrl: options.baseUrl,
          apiKeyEnv: options.apiKeyEnv,
        });
        if (options.default) manager.setDefaultModel(modelName, provider);
        process.stdout.write(`Added ${result.value}\n`);
        if (options.default) process.stdout.write(`Set default model to ${provider}/${modelName}\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        if (isPromptAbortError(error)) {
          process.stderr.write('Aborted.\n');
          process.exitCode = 130;
          return;
        }
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt?.close();
      }
    });

  model
    .command('default')
    .description('Set the global default model, or a profile model override.')
    .argument('[model]', 'Model name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--profile <name>', 'Write the model override to this profile.')
    .option('--clear', 'Clear a profile model override.')
    .action(async (modelName: string | undefined, options: ModelDefaultOptions) => {
      let prompt: InteractivePrompt | undefined;
      try {
        const loadedConfig = loadConfig(program);
        const style = new TerminalStyle();
        const getPrompt = (): InteractivePrompt => {
          prompt ??= new InteractivePrompt();
          return prompt;
        };

        if (options.profile) {
          const profileManager = new ProfileManager(loadedConfig.config.paths.profilesDir);
          if (options.clear) {
            const result = profileManager.clearModelOverride(options.profile);
            process.stdout.write(`Cleared model override for profile '${result.name}'.\n`);
            process.stdout.write(`Updated ${result.path}\n`);
            return;
          }

          if (!modelName) {
            const selected = await selectProfileDefaultModel(loadedConfig, getPrompt, style, options.profile);
            if (selected === USE_GLOBAL_DEFAULT) {
              const result = profileManager.clearModelOverride(options.profile);
              process.stdout.write(`Cleared model override for profile '${result.name}'.\n`);
              process.stdout.write(`Updated ${result.path}\n`);
              return;
            }
            const { provider, model } = await resolveSelectedDefaultModel(loadedConfig, getPrompt, style, selected);
            const result = profileManager.setModelOverride(options.profile, provider, model);
            process.stdout.write(`Set profile '${result.name}' model to ${provider}/${model}.\n`);
            process.stdout.write(`Updated ${result.path}\n`);
            return;
          }

          const { provider, model } = resolveModelPair(modelName, options.provider, loadedConfig);
          const result = profileManager.setModelOverride(options.profile, provider, model);
          process.stdout.write(`Set profile '${result.name}' model to ${provider}/${model}.\n`);
          process.stdout.write(`Updated ${result.path}\n`);
          return;
        }

        if (options.clear) throw MarifoldError.configInvalid('--clear is only valid with --profile.');
        if (!modelName) {
          const selected = await selectGlobalDefaultModel(loadedConfig, getPrompt, style);
          const { provider, model } = await resolveSelectedDefaultModel(loadedConfig, getPrompt, style, selected);
          const result = new ConfigManager(loadedConfig).setDefaultModel(model, provider);
          process.stdout.write(`Set ${result.value}\n`);
          process.stdout.write(`Saved ${result.configPath}\n`);
          return;
        }
        const { provider, model } = resolveModelPair(modelName, options.provider, loadedConfig);
        const result = new ConfigManager(loadedConfig).setDefaultModel(model, provider);
        process.stdout.write(`Set ${result.value}\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        if (isPromptAbortError(error)) {
          process.stderr.write('Aborted.\n');
          process.exitCode = 130;
          return;
        }
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt?.close();
      }
    });
}

function resolveModelValidationTarget(
  runtime: ReturnType<typeof createRuntime>,
  modelArg: string | undefined,
  options: ModelValidateOptions,
): { provider: string; model: string } {
  if (modelArg?.includes('/')) {
    const [provider, ...rest] = modelArg.split('/');
    const model = rest.join('/');
    if (!provider || !model) throw MarifoldError.configInvalid('Invalid model format. Use provider/model.');
    return { provider, model };
  }

  if (modelArg) {
    if (!options.provider) throw MarifoldError.configInvalid('Use provider/model or pass --provider <name>.');
    return { provider: options.provider, model: modelArg };
  }

  const settings = runtime.resolveSettings({
    profile: options.profile,
    provider: options.provider,
  });
  return { provider: settings.provider, model: settings.model };
}

function normalizedModelOptions(options: string[], provider?: string, model?: string): string[] {
  const set = new Set(options);
  if (provider && model) set.add(`${provider}/${model}`);
  return [...set].sort();
}

async function selectGlobalDefaultModel(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
): Promise<string> {
  const choices = normalizedModelOptions(
    loadedConfig.config.models.options,
    loadedConfig.config.default.provider,
    loadedConfig.config.default.model,
  ).filter(isChatCompatibleModelOption);
  choices.push(ADD_NEW_MODEL);
  return selectModelOption(getPrompt, style, 'Select default model:', choices, {
    addNewLabel: 'Add new model...',
  });
}

async function selectProfileDefaultModel(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  profile: string,
): Promise<string> {
  const choices = [
    USE_GLOBAL_DEFAULT,
    ...normalizedModelOptions(
      loadedConfig.config.models.options,
      loadedConfig.config.default.provider,
      loadedConfig.config.default.model,
    ).filter(isChatCompatibleModelOption),
    ADD_NEW_MODEL,
  ];
  return selectModelOption(getPrompt, style, `Select model for profile '${profile}':`, choices, {
    useDefaultLabel: `Use default (${globalDefaultLabel(loadedConfig)})`,
    addNewLabel: 'Add new model...',
  });
}

async function selectModelOption(
  getPrompt: PromptFactory,
  style: TerminalStyle,
  message: string,
  choices: string[],
  labels: {
    useDefaultLabel?: string;
    addNewLabel: string;
  },
): Promise<string> {
  if (choices.length === 0) return ADD_NEW_MODEL;
  const selected = await selectTerminalOption(message, choices.map(choice => ({
    label: modelChoiceLabel(choice, labels),
    value: choice,
  })));
  if (selected !== undefined) return selected;

  process.stdout.write(`${message}\n`);
  choices.forEach((choice, index) => {
    process.stdout.write(`  ${index + 1}. ${modelChoiceLabel(choice, labels)}\n`);
  });
  return readChoice(getPrompt(), style, 'Model', choices, {
    defaultIndex: 0,
  });
}

async function resolveSelectedDefaultModel(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  selected: string,
): Promise<{ provider: string; model: string }> {
  if (selected !== ADD_NEW_MODEL) return parseProviderModelOption(selected);

  process.stdout.write('\n');
  const target = await resolveModelAddTarget(loadedConfig, getPrompt, style);
  new ConfigManager(loadedConfig).addModel(target.provider, target.model);
  process.stdout.write(`Added ${target.provider}/${target.model}\n`);
  return target;
}

function resolveModelPair(
  modelArg: string,
  providerArg: string | undefined,
  loadedConfig: LoadedMarifoldConfig,
): { provider: string; model: string } {
  if (modelArg.includes('/')) return parseProviderModelOption(modelArg);
  const provider = providerArg ?? loadedConfig.config.default.provider;
  if (!provider) throw MarifoldError.missingProviderModel(loadedConfig.configPath);
  return { provider, model: modelArg };
}

function parseProviderModelOption(option: string): { provider: string; model: string } {
  const [provider, ...rest] = option.split('/');
  const model = rest.join('/');
  if (!provider || !model) throw MarifoldError.configInvalid('Invalid model format. Use provider/model.');
  return { provider, model };
}

function modelChoiceLabel(
  choice: string,
  labels: {
    useDefaultLabel?: string;
    addNewLabel: string;
  },
): string {
  if (choice === USE_GLOBAL_DEFAULT) return labels.useDefaultLabel ?? 'Use default';
  if (choice === ADD_NEW_MODEL) return labels.addNewLabel;
  return choice;
}

function globalDefaultLabel(loadedConfig: LoadedMarifoldConfig): string {
  const provider = loadedConfig.config.default.provider;
  const model = loadedConfig.config.default.model;
  return provider && model ? `${provider}/${model}` : 'none';
}

function isChatCompatibleModelOption(option: string): boolean {
  const parsed = parseProviderModelOption(option);
  if (parsed.provider !== 'github_copilot') return true;
  return !isKnownGitHubCopilotUnsupportedModelId(parsed.model);
}

function assertCanSaveModelOption(provider: string, model: string): void {
  if (provider === 'github_copilot' && isKnownGitHubCopilotUnsupportedModelId(model)) {
    throw MarifoldError.configInvalid(
      `Model '${provider}/${model}' is not supported by Marifold's current GitHub Copilot adapters.`,
    );
  }
}

async function resolveModelAddTarget(
  loadedConfig: LoadedMarifoldConfig,
  getPrompt: PromptFactory,
  style: TerminalStyle,
  providerArg?: string,
  modelArg?: string,
  options: ModelAddOptions = {},
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

async function readChoice(
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
  options: ModelAddOptions,
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

function providerHasUsableCredential(provider: MarifoldProviderConfig | undefined, options: ModelAddOptions): boolean {
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

function parseProviderType(value?: string): ProviderType | undefined {
  if (value === undefined) return undefined;
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid('Expected --provider-type to be "ollama", "openai-compatible", or "anthropic".');
}
