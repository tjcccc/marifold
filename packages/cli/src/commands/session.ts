import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

interface SessionListOptions {
  limit?: string;
}

export function registerSessionCommand(program: Command, printer: ConsolePrinter): void {
  const session = program
    .command('session')
    .description('Inspect Marifold chat sessions.');

  session
    .command('list')
    .description('List recent sessions.')
    .option('--limit <number>', 'Maximum number of sessions to print.', '50')
    .action((options: SessionListOptions) => {
      const runtime = createRuntime(program);
      try {
        const limit = Number.parseInt(options.limit ?? '50', 10);
        printer.printSessions(runtime.listSessions(Number.isFinite(limit) ? limit : 50));
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });
}
