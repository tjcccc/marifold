import { Command } from 'commander';
import { MarifoldError } from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { PromptAbortError, isPromptAbortError } from '../input/PromptAbort';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

interface SessionListOptions {
  limit?: string;
  profile?: string;
}

interface SessionClearOptions {
  profile?: string;
  before?: string;
  keepLast?: string;
  yes?: boolean;
}

export function registerSessionCommand(program: Command, printer: ConsolePrinter): void {
  const session = program
    .command('session')
    .description('Inspect Marifold chat sessions.');

  session
    .command('list')
    .description('List recent sessions.')
    .option('--limit <number>', 'Maximum number of sessions to print.', '50')
    .option('--profile <name>', 'Only list sessions for this profile.')
    .action((options: SessionListOptions) => {
      const runtime = createRuntime(program);
      try {
        const limit = Number.parseInt(options.limit ?? '50', 10);
        printer.printSessions(runtime.listSessions(Number.isFinite(limit) ? limit : 50, options.profile));
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
    .command('clear')
    .description('Clear sessions with optional filters.')
    .option('--profile <name>', 'Only clear sessions for this profile.')
    .option('--before <date>', 'Only clear sessions updated before this date or ISO timestamp.')
    .option('--keep-last <number>', 'Keep this many newest matching sessions.', '0')
    .option('--yes', 'Clear without interactive confirmation.')
    .action(async (options: SessionClearOptions) => {
      const runtime = createRuntime(program);
      const prompt = new InteractivePrompt();
      try {
        const keepLast = parseKeepLast(options.keepLast);
        const before = options.before ? parseBefore(options.before) : undefined;
        if (!options.yes) {
          const summary = [
            options.profile ? `profile '${options.profile}'` : 'all profiles',
            before ? `updated before ${before}` : undefined,
            keepLast > 0 ? `keeping ${keepLast} newest matching session(s)` : undefined,
          ].filter(Boolean).join(', ');
          const answer = await prompt.readUserMessage(`Clear sessions for ${summary}? Type CLEAR to confirm: `);
          if (answer === undefined) throw new PromptAbortError();
          if (answer.trim() !== 'CLEAR') {
            process.stdout.write('Aborted.\n');
            process.exitCode = 1;
            return;
          }
        }

        const result = runtime.clearSessions({
          profileName: options.profile,
          before,
          keepLast,
        });
        process.stdout.write(`Cleared ${result.count} session(s).\n`);
      } catch (error) {
        if (isPromptAbortError(error)) {
          process.stderr.write('Aborted.\n');
          process.exitCode = 130;
          return;
        }
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt.close();
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

function parseKeepLast(value?: string): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw MarifoldError.configInvalid('--keep-last must be a non-negative integer.');
  }
  return parsed;
}

function parseBefore(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw MarifoldError.configInvalid('--before must be a valid date or ISO timestamp.');
  }
  return date.toISOString();
}
