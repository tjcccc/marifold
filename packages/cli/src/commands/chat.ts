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
const CHAT_HELP = `Chat commands:
  /help       Show this help.
  /new        Start a new session with the same profile and model.
  /exit       Exit the chat.
  /quit       Exit the chat.
  \\           End a line with backslash to continue on the next line.
`;

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
      let sessionId = options.session ?? randomUUID();

      try {
        const settings = runtime.resolveSettings({
          profile: options.profile,
          provider: options.provider,
          model: options.model,
        });

        process.stdout.write(`Model:    ${settings.provider}/${settings.model}\n`);
        process.stdout.write(`Profile:  ${settings.profile}\n`);
        process.stdout.write(`Session:  ${sessionId}\n`);
        process.stdout.write('Type /help for commands, Ctrl-C to quit.\n\n');

        while (true) {
          const raw = await prompt.readMultilineMessage('user > ');
          if (raw === undefined) break;

          const message = raw.trim();
          if (!message) continue;
          if (EXIT_COMMANDS.has(message.toLowerCase())) break;
          if (message === '/help') {
            process.stdout.write(`${CHAT_HELP}\n`);
            continue;
          }
          if (message === '/new') {
            sessionId = randomUUID();
            process.stdout.write(`New session: ${sessionId}\n\n`);
            continue;
          }
          if (message.startsWith('/')) {
            process.stderr.write(`Unknown command: ${message}. Type /help for commands.\n`);
            continue;
          }

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
