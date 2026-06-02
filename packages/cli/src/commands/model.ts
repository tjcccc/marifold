import { Command } from 'commander';
import { ConfigManager, MarifoldError, ProfileManager } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

interface ModelDefaultOptions {
  provider?: string;
  profile?: string;
  clear?: boolean;
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
