import { Command } from 'commander';
import { ConfigManager, renderMarifoldConfig } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

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
}
