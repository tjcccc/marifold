import { Command } from 'commander';
import {
  ConfigManager,
  LoadedMarifoldConfig,
  MarifoldError,
  ProfileManager,
  ProviderInspector,
  ProviderType,
  isKnownGitHubCopilotUnsupportedModelId,
} from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { isPromptAbortError } from '../input/PromptAbort';
import { readChoice, resolveModelAddTarget, type PromptFactory } from '../input/ModelPicker';
import { selectTerminalOption } from '../input/TerminalSelect';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { createRuntime, loadConfig } from './RuntimeFactory';

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
  all?: boolean;
}

interface ModelRemoveOptions {
  provider?: string;
}

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
    .option('--all', 'Validate every saved model plus global and profile model defaults.')
    .action(async (modelArg: string | undefined, options: ModelValidateOptions) => {
      let runtime: ReturnType<typeof createRuntime> | undefined;
      try {
        runtime = createRuntime(program);
        const loadedConfig = loadConfig(program);
        const inspector = new ProviderInspector(loadedConfig);
        if (options.all) {
          if (modelArg || options.provider || options.profile) {
            throw MarifoldError.configInvalid('--all cannot be combined with a model argument, --provider, or --profile.');
          }
          const targets = collectModelValidationTargets(loadedConfig, runtime);
          if (targets.length === 0) {
            throw MarifoldError.missingProviderModel(loadedConfig.configPath);
          }
          let hasError = false;
          for (const target of targets) {
            const result = await inspector.validateModel(target.provider, target.model);
            process.stdout.write(`${result.status.toUpperCase()} ${result.provider}/${result.model} [${target.sources.join(', ')}]: ${result.message}\n`);
            if (!result.valid) hasError = true;
          }
          if (hasError) process.exitCode = 1;
          return;
        }

        const resolved = resolveModelValidationTarget(runtime, modelArg, options);
        const result = await inspector.validateModel(resolved.provider, resolved.model);
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
    .command('rm')
    .alias('remove')
    .description('Remove a saved provider/model option from Marifold config.')
    .argument('<model>', 'Provider/model pair, or model name when --provider is set.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .action((modelArg: string, options: ModelRemoveOptions) => {
      try {
        const loadedConfig = loadConfig(program);
        const { provider, model } = resolveModelPair(modelArg, options.provider, loadedConfig);
        const result = new ConfigManager(loadedConfig).removeModel(provider, model);
        if (!result.removed) {
          process.stderr.write(`Saved model option not found: ${result.value}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`Removed ${result.value}\n`);
        if (result.wasDefault) {
          process.stdout.write('Current default model is unchanged.\n');
        }
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
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

function collectModelValidationTargets(
  loadedConfig: LoadedMarifoldConfig,
  runtime: ReturnType<typeof createRuntime>,
): Array<{ provider: string; model: string; sources: string[] }> {
  const targets = new Map<string, { provider: string; model: string; sources: Set<string> }>();
  const add = (provider: string | undefined, model: string | undefined, source: string): void => {
    if (!provider || !model) return;
    const key = `${provider}/${model}`;
    const existing = targets.get(key);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    targets.set(key, { provider, model, sources: new Set([source]) });
  };

  add(loadedConfig.config.default.provider, loadedConfig.config.default.model, 'default');
  for (const option of loadedConfig.config.models.options) {
    const parsed = parseProviderModelOption(option);
    add(parsed.provider, parsed.model, 'saved');
  }
  for (const profile of runtime.listProfiles()) {
    const detail = runtime.getProfile(profile.name);
    add(detail.settings.provider, detail.settings.model, `profile:${profile.name}`);
  }

  return [...targets.values()]
    .map(target => ({
      provider: target.provider,
      model: target.model,
      sources: [...target.sources].sort(),
    }))
    .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
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

function parseProviderType(value?: string): ProviderType | undefined {
  if (value === undefined) return undefined;
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid('Expected --provider-type to be "ollama", "openai-compatible", or "anthropic".');
}
