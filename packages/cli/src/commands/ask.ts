import { workspaceClient } from './WorkspaceClient';
import { prepareImageInputs, type MarifoldAskResponse } from '@marifold/core';
import { Command } from 'commander';
import { expandHome } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';

interface AskOptions {
  workspace?: string;
  profile?: string;
  provider?: string;
  model?: string;
  session?: string;
  memories?: boolean;
  think?: boolean;
  image?: string[];
}

export function registerAskCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('ask')
    .description('Send one prompt and print one assistant response.')
    .argument('<prompt...>', 'Prompt text.')
    .option('--workspace <nameOrId>', 'Use a saved workspace, or local.')
    .option('--profile <name>', 'Profile name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--model <model>', 'Model name.')
    .option('--session <id>', 'Optional session id for continuity.')
    .option('--no-memories', 'Disable profile memory for this run.')
    .option('--think [state]', 'Enable or disable thinking mode for this run. Accepts true/false.', parseOptionalBoolean)
    .option('--image <path>', 'Attach an image file to the prompt. Repeatable.', collectImage, [] as string[])
    .action(async (promptParts: string[], options: AskOptions) => {
      const api = await workspaceClient(program, options.workspace);
      const runtime = api ? undefined : createRuntime(program);
      try {
        const request = {
          prompt: promptParts.join(' '),
          profile: options.profile,
          provider: options.provider,
          model: options.model,
          sessionId: options.session,
          memories: options.memories,
          think: options.think,
          images: options.image && options.image.length > 0 ? (await prepareImageInputs(options.image.map(path => ({ path: expandHome(path) })))).images : undefined,
        };
        const response = api ? await api.request<MarifoldAskResponse>('POST', '/v1/ask', request) : await runtime!.ask(request);
        printer.printAskResponse(response);
        if (!response.ok) process.exitCode = 1;
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime?.close();
      }
    });
}

function collectImage(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseOptionalBoolean(value?: string): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  throw new Error('Expected --think to be true or false.');
}
