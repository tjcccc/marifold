import { Command } from 'commander';
import { ConfigManager, MarifoldError, ProfileManager } from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';
import { loadConfig } from './RuntimeFactory';

export function registerProfileCommand(program: Command, printer: ConsolePrinter): void {
  const profile = program
    .command('profile')
    .description('Inspect and manage Marifold profiles.')
    .action(() => {
      try {
        const { config } = loadConfig(program);
        process.stdout.write(`Current profile: ${config.default.profile}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  profile
    .command('list')
    .description('List available profiles.')
    .action(() => {
      const runtime = createRuntime(program);
      try {
        printer.printProfiles(runtime.listProfiles());
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  profile
    .command('init')
    .description('Scaffold a new profile directory.')
    .argument('[name]', 'Profile name.')
    .action(async (name: string | undefined) => {
      const prompt = new InteractivePrompt();
      try {
        const loadedConfig = loadConfig(program);
        const profileName = name ?? (await prompt.readUserMessage('Profile name: '))?.trim();
        if (!profileName) throw MarifoldError.profileInvalid('Profile name cannot be empty.', '');

        const result = new ProfileManager(loadedConfig.config.paths.profilesDir).init(profileName);
        process.stdout.write(`Created profile '${result.name}' at ${result.path}\n`);
        for (const filePath of result.files) process.stdout.write(`created ${filePath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt.close();
      }
    });

  profile
    .command('default')
    .description('Show or set the default profile.')
    .argument('[name]', 'Profile name to set as default.')
    .action((name: string | undefined) => {
      try {
        const loadedConfig = loadConfig(program);
        if (!name) {
          process.stdout.write(`Current profile: ${loadedConfig.config.default.profile}\n`);
          return;
        }

        const profileManager = new ProfileManager(loadedConfig.config.paths.profilesDir);
        if (!profileManager.exists(name)) {
          throw MarifoldError.profileInvalid(`Profile '${name}' was not found.`, name);
        }
        const result = new ConfigManager(loadedConfig).setDefaultProfile(name);
        process.stdout.write(`Default profile set to '${name}'.\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}
