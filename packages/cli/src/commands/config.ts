import { Command } from 'commander';
import { ConfigManager, exportConfigBackup, importConfigBackup, renderMarifoldConfig } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

interface ConfigExportOptions {
  includeSessions?: boolean;
}

interface ConfigImportOptions {
  force?: boolean;
}

export function registerConfigCommand(program: Command, printer: ConsolePrinter): void {
  const config = program
    .command('config')
    .description('Inspect and update Marifold configuration.');

  config
    .command('show')
    .description('Print the resolved Marifold config.')
    .action(() => {
      try {
        const loadedConfig = loadConfig(program);
        process.stdout.write(renderMarifoldConfig(loadedConfig.config));
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('set')
    .description('Set a config value by dotted key.')
    .argument('<key>', 'Dotted config key, e.g. default.model.')
    .argument('<value>', 'Value to write.')
    .action((key: string, value: string) => {
      try {
        const result = new ConfigManager(loadConfig(program)).setValue(key, value);
        process.stdout.write(`Set ${result.key} = ${result.value}\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('export')
    .description('Export local config, profiles, memories, and optionally sessions to a backup file.')
    .argument('<file>', 'Backup file path.')
    .option('--include-sessions', 'Include the SQLite sessions database in the backup.')
    .action((file: string, options: ConfigExportOptions) => {
      try {
        const result = exportConfigBackup(loadConfig(program), file, {
          includeSessions: options.includeSessions,
        });
        process.stdout.write(`Exported config backup to ${result.path}\n`);
        process.stdout.write(`Profile files: ${result.profileFileCount}\n`);
        process.stdout.write(`Sessions: ${result.includedSessions ? 'included' : 'not included'}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('import')
    .description('Import a Marifold config backup file.')
    .argument('<file>', 'Backup file path.')
    .option('--force', 'Overwrite existing config, profile files, and sessions database.')
    .action((file: string, options: ConfigImportOptions) => {
      try {
        const result = importConfigBackup(loadConfig(program), file, {
          force: options.force,
        });
        process.stdout.write(`Imported config backup to ${result.configPath}\n`);
        process.stdout.write(`Profile files: ${result.profileFileCount}\n`);
        process.stdout.write(`Sessions: ${result.restoredSessions ? 'restored' : 'not included'}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}
