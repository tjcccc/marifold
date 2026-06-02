import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

export function registerProfileCommand(program: Command, printer: ConsolePrinter): void {
  const profile = program
    .command('profile')
    .description('Inspect Marifold profiles.');

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
}
