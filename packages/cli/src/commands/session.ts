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

  session
    .command('show')
    .description('Show one session and its turns.')
    .argument('<id>', 'Session id.')
    .action((id: string) => {
      const runtime = createRuntime(program);
      try {
        const detail = runtime.getSession(id);
        if (!detail) {
          process.stderr.write(`Session not found: ${id}\n`);
          process.exitCode = 1;
          return;
        }

        process.stdout.write(`Session: ${detail.id}\n`);
        process.stdout.write(`Profile: ${detail.profileName}\n`);
        process.stdout.write(`Created: ${detail.createdAt}\n`);
        process.stdout.write(`Updated: ${detail.updatedAt}\n`);
        process.stdout.write(`Turns:   ${detail.turnCount}\n\n`);
        for (const turn of detail.turns) {
          process.stdout.write(`${turn.role} · ${turn.timestamp}\n`);
          process.stdout.write(`${turn.content}\n\n`);
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  session
    .command('delete')
    .description('Delete a session and all of its turns.')
    .argument('<id>', 'Session id.')
    .action((id: string) => {
      const runtime = createRuntime(program);
      try {
        if (!runtime.deleteSession(id)) {
          process.stderr.write(`Session not found: ${id}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`Deleted session ${id}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  session
    .command('rename')
    .description('Rename a session id.')
    .argument('<from>', 'Current session id.')
    .argument('<to>', 'New session id.')
    .action((from: string, to: string) => {
      const runtime = createRuntime(program);
      try {
        if (!runtime.renameSession(from, to)) {
          process.stderr.write(`Session not found: ${from}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`Renamed session ${from} to ${to}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });
}
