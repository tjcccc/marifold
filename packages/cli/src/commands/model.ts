import { Command } from 'commander';
import { ConfigManager, MarifoldError, ProfileManager, ProviderType } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
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
    .command('add')
    .description('Add a provider/model option to config.')
    .argument('<provider>', 'Provider key.')
    .argument('<model>', 'Model name.')
    .option('--provider-type <type>', 'Provider type: ollama, openai-compatible, or anthropic.')
    .option('--base-url <url>', 'Provider base URL.')
    .option('--api-key-env <name>', 'Environment variable containing the API key.')
    .option('--default', 'Also make this the global default model.')
    .action((provider: string, modelName: string, options: ModelAddOptions) => {
      try {
        const loadedConfig = loadConfig(program);
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
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  model
    .command('default')
    .description('Set the global default model, or a profile model override.')
    .argument('[model]', 'Model name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--profile <name>', 'Write the model override to this profile.')
    .option('--clear', 'Clear a profile model override.')
    .action((modelName: string | undefined, options: ModelDefaultOptions) => {
      try {
        const loadedConfig = loadConfig(program);

        if (options.profile) {
          const profileManager = new ProfileManager(loadedConfig.config.paths.profilesDir);
          if (options.clear) {
            const result = profileManager.clearModelOverride(options.profile);
            process.stdout.write(`Cleared model override for profile '${result.name}'.\n`);
            process.stdout.write(`Updated ${result.path}\n`);
            return;
          }

          if (!modelName) throw MarifoldError.configInvalid('Model name is required.');
          const provider = options.provider ?? loadedConfig.config.default.provider;
          if (!provider) throw MarifoldError.missingProviderModel(loadedConfig.configPath);
          const result = profileManager.setModelOverride(options.profile, provider, modelName);
          process.stdout.write(`Set profile '${result.name}' model to ${provider}/${modelName}.\n`);
          process.stdout.write(`Updated ${result.path}\n`);
          return;
        }

        if (options.clear) throw MarifoldError.configInvalid('--clear is only valid with --profile.');
        if (!modelName) throw MarifoldError.configInvalid('Model name is required.');
        const result = new ConfigManager(loadedConfig).setDefaultModel(modelName, options.provider);
        process.stdout.write(`Set ${result.value}\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function normalizedModelOptions(options: string[], provider?: string, model?: string): string[] {
  const set = new Set(options);
  if (provider && model) set.add(`${provider}/${model}`);
  return [...set].sort();
}

function parseProviderType(value?: string): ProviderType | undefined {
  if (value === undefined) return undefined;
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid('Expected --provider-type to be "ollama", "openai-compatible", or "anthropic".');
}
