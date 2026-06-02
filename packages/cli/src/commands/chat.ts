import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

interface ChatOptions {
  profile?: string;
  provider?: string;
  model?: string;
  session?: string;
}

const EXIT_COMMANDS = new Set(['/exit', '/quit']);

export function registerChatCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('chat')
    .description('Start an interactive Marifold chat session.')
    .option('--profile <name>', 'Profile name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--model <model>', 'Model name.')
    .option('--session <id>', 'Session id to continue or create.')
    .action(async (options: ChatOptions) => {
      const runtime = createRuntime(program);
      const prompt = new InteractivePrompt();
      const sessionId = options.session ?? randomUUID();

      try {
        const settings = runtime.resolveSettings({
          profile: options.profile,
          provider: options.provider,
          model: options.model,
        });

        process.stdout.write('Marifold v0.0.1\n');
        process.stdout.write(`Model:   ${settings.provider}/${settings.model}\n`);
        process.stdout.write(`Profile: ${settings.profile}\n`);
        process.stdout.write(`Session: ${sessionId}\n`);
        process.stdout.write('Type /exit or /quit to leave.\n\n');

        while (true) {
          const raw = await prompt.readUserMessage('user> ');
          if (raw === undefined) break;

          const message = raw.trim();
          if (!message) continue;
          if (EXIT_COMMANDS.has(message.toLowerCase())) break;

          process.stdout.write('assistant> ');
          for await (const chunk of runtime.stream({
            prompt: message,
            profile: settings.profile,
            provider: settings.provider,
            model: settings.model,
            sessionId,
          })) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n\n');
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt.close();
        runtime.close();
      }
    });
}
