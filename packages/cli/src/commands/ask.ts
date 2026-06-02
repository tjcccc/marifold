import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

interface AskOptions {
  profile?: string;
  provider?: string;
  model?: string;
  session?: string;
}

export function registerAskCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('ask')
    .description('Send one prompt and print one assistant response.')
    .argument('<prompt...>', 'Prompt text.')
    .option('--profile <name>', 'Profile name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--model <model>', 'Model name.')
    .option('--session <id>', 'Optional session id for continuity.')
    .action(async (promptParts: string[], options: AskOptions) => {
      const runtime = createRuntime(program);
      try {
        const response = await runtime.ask({
          prompt: promptParts.join(' '),
          profile: options.profile,
          provider: options.provider,
          model: options.model,
          sessionId: options.session,
        });
        printer.printAskResponse(response);
        if (!response.ok) process.exitCode = 1;
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });
}
