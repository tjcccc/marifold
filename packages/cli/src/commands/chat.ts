import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { expandHome } from '@marifold/core';
import type { ImageInput, MemoryKind } from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { createRuntime } from './RuntimeFactory';

interface ChatOptions {
  profile?: string;
  provider?: string;
  model?: string;
  session?: string;
  resume?: boolean | string;
  memories?: boolean;
  think?: boolean;
}

const EXIT_COMMANDS = new Set(['/exit', '/quit']);
const READ_FILE_CHAR_LIMIT = 100000;
const CHAT_HELP = `Chat commands:
  /help                 Show this help.
  /new                  Start a new session with the same profile and model.
  /think on             Enable thinking mode for supported providers.
  /think off            Disable thinking mode.
  /read <path>          Attach a local file's content to your next message.
  /image <path>         Attach an image to your next message. Repeatable.
  /image clear          Drop pending image attachments.
  /remember <text>      Save short-term memory.
  /remember user <text> Save durable user memory.
  /remember pref <text> Save durable preference memory.
  /forget <query>       Soft-forget matching active memory.
  /delete-memory <q>    Permanently delete matching memory records.
  /exit                 Exit the chat.
  /quit                 Exit the chat.
  \\                     End a line with backslash to continue on the next line.
`;

export function registerChatCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('chat')
    .description('Start an interactive Marifold chat session.')
    .option('--profile <name>', 'Profile name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--model <model>', 'Model name.')
    .option('--session <id>', 'Session id to continue or create.')
    .option('--resume [mode]', 'Resume a profile session. Use "last" for the most recent session.')
    .option('--no-memories', 'Disable profile memory for this chat run.')
    .option('--think [state]', 'Enable or disable thinking mode for this chat run. Accepts true/false.', parseOptionalBoolean)
    .action(async (options: ChatOptions) => {
      const runtime = createRuntime(program);
      const prompt = new InteractivePrompt();
      const style = new TerminalStyle();
      let sessionId = options.session ?? randomUUID();
      let think = false;
      const pendingContext: string[] = [];
      const pendingImages: ImageInput[] = [];

      try {
        const settings = runtime.resolveSettings({
          profile: options.profile,
          provider: options.provider,
          model: options.model,
          think: options.think,
        });
        think = settings.think;
        if (options.session && options.resume !== undefined) {
          throw new Error('--session and --resume are mutually exclusive.');
        }

        if (options.resume !== undefined) {
          sessionId = await resolveResumeSession(runtime, prompt, settings.profile, options.resume);
        }

        const memoryOn = runtime.memoryEnabled(settings.profile, options.memories);
        if (memoryOn) runtime.ensureProfileMemoryFiles(settings.profile);

        process.stdout.write(style.dim(`Model:    ${settings.provider}/${settings.model}\n`));
        process.stdout.write(style.dim(`Profile:  ${settings.profile}\n`));
        process.stdout.write(style.dim(`Session:  ${sessionId}\n`));
        process.stdout.write(style.dim(`Memory:   ${memoryOn ? 'on' : 'off'}\n`));
        process.stdout.write(style.dim(`Think:    ${think ? 'on' : 'off'}\n`));
        process.stdout.write(style.dim('Type /help for commands, Ctrl-C to quit.\n\n'));

        const streamTurn = async (turnPrompt: string, extraContext: string[] = []): Promise<void> => {
          const userContext = [...extraContext, ...pendingContext.splice(0)];
          const images = pendingImages.splice(0);
          let responseStarted = false;
          let reasoningStarted = false;
          for await (const chunk of runtime.stream({
            prompt: turnPrompt,
            profile: settings.profile,
            provider: settings.provider,
            model: settings.model,
            sessionId,
            memories: options.memories,
            think,
            userContext: userContext.length > 0 ? userContext : undefined,
            images: images.length > 0 ? images : undefined,
          }, undefined, summary => {
            if (!reasoningStarted) {
              process.stdout.write(`\n${style.dim('reasoning >')}\n`);
              reasoningStarted = true;
            }
            process.stdout.write(style.dim(summary));
          })) {
            if (!responseStarted) {
              if (reasoningStarted) process.stdout.write('\n');
              process.stdout.write(`\n${style.bold(`${settings.profile} >`)}\n`);
              responseStarted = true;
            }
            process.stdout.write(chunk);
          }
          if (!responseStarted) process.stdout.write(`\n${style.bold(`${settings.profile} >`)}\n`);
          process.stdout.write('\n\n');
        };

        while (true) {
          const raw = await prompt.readMultilineMessage(style.bold('user > '), style.dim('... > '));
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
            process.stdout.write(style.dim(`New session: ${sessionId}\n\n`));
            continue;
          }
          if (isCommand(message, '/think')) {
            const next = parseThinkCommand(message);
            if (next === undefined) {
              process.stderr.write('Usage: /think on|off\n');
              continue;
            }
            think = next;
            process.stdout.write(style.dim(`Thinking mode ${think ? 'on' : 'off'}.\n\n`));
            continue;
          }
          if (isCommand(message, '/read')) {
            const filePath = commandPayload(message, '/read');
            if (!filePath) {
              process.stderr.write('Usage: /read <path>\n');
              continue;
            }
            const attached = readFileForChat(filePath);
            if (!attached) continue;
            pendingContext.push(attached.block);
            process.stdout.write(style.dim(`Attached ${attached.path} (${attached.chars} chars) to your next message.\n\n`));
            continue;
          }
          if (isCommand(message, '/image')) {
            const payload = commandPayload(message, '/image');
            if (!payload) {
              process.stderr.write('Usage: /image <path> | /image clear\n');
              continue;
            }
            if (payload.toLowerCase() === 'clear') {
              pendingImages.length = 0;
              process.stdout.write(style.dim('Cleared pending images.\n\n'));
              continue;
            }
            const imagePath = path.resolve(expandHome(payload));
            if (!fs.existsSync(imagePath)) {
              process.stderr.write(`Image not found: ${imagePath}\n`);
              continue;
            }
            pendingImages.push({ path: imagePath });
            process.stdout.write(style.dim(`Attached image #${pendingImages.length}: ${imagePath}\n\n`));
            continue;
          }
          if (isCommand(message, '/remember')) {
            const parsed = parseRememberCommand(message);
            if (!parsed) {
              process.stderr.write('Usage: /remember [user|pref] <text>\n');
              continue;
            }
            const result = runtime.rememberMemory(settings.profile, parsed.kind, parsed.text, sessionId);
            const verb = result.created ? 'Remembered' : 'Already remembered';
            process.stdout.write(style.dim(`${verb} ${memoryKindLabel(result.kind)} memory: ${result.entry.id}\n\n`));
            continue;
          }
          if (isCommand(message, '/forget')) {
            const query = commandPayload(message, '/forget');
            if (!query) {
              process.stderr.write('Usage: /forget <query>\n');
              continue;
            }
            const result = runtime.forgetMemories(settings.profile, query);
            process.stdout.write(style.dim(formatMutationResult('Forgot', result.count)));
            continue;
          }
          if (isCommand(message, '/delete-memory')) {
            const query = commandPayload(message, '/delete-memory');
            if (!query) {
              process.stderr.write('Usage: /delete-memory <query>\n');
              continue;
            }
            const result = runtime.deleteMemories(settings.profile, query);
            process.stdout.write(style.dim(formatMutationResult('Deleted', result.count)));
            continue;
          }
          if (message.startsWith('/')) {
            process.stderr.write(`Unknown command: ${message}. Type /help for commands.\n`);
            continue;
          }

          await streamTurn(message);
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

function parseOptionalBoolean(value?: string): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  throw new Error('Expected --think to be true or false.');
}

function parseThinkCommand(message: string): boolean | undefined {
  const payload = commandPayload(message, '/think').toLowerCase();
  if (payload === 'on' || payload === 'true' || payload === '1') return true;
  if (payload === 'off' || payload === 'false' || payload === '0') return false;
  return undefined;
}

async function resolveResumeSession(
  runtime: ReturnType<typeof createRuntime>,
  prompt: InteractivePrompt,
  profile: string,
  resume: boolean | string,
): Promise<string> {
  if (resume === 'last') {
    const latest = runtime.latestSession(profile);
    if (!latest) {
      process.stderr.write(`No sessions found for profile '${profile}'. Starting a new session.\n`);
      return randomUUID();
    }
    return latest.id;
  }

  if (resume !== true) {
    return String(resume);
  }

  const sessions = runtime.listSessions(20, profile);
  if (sessions.length === 0) {
    process.stderr.write(`No sessions found for profile '${profile}'. Starting a new session.\n`);
    return randomUUID();
  }

  process.stdout.write(`Recent sessions for profile '${profile}':\n`);
  for (const session of sessions) {
    process.stdout.write(`${session.id}\t${session.turnCount} turns\t${session.updatedAt}\n`);
  }
  const selected = (await prompt.readUserMessage('Session id: '))?.trim();
  return selected || randomUUID();
}

function parseRememberCommand(message: string): { kind: MemoryKind; text: string } | undefined {
  const payload = commandPayload(message, '/remember');
  if (!payload) return undefined;

  const firstSpace = payload.search(/\s/);
  const first = firstSpace === -1 ? payload : payload.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : payload.slice(firstSpace + 1).trim();

  switch (first.toLowerCase()) {
    case 'user':
      return rest ? { kind: 'user', text: rest } : undefined;
    case 'pref':
    case 'prefs':
    case 'preference':
    case 'preferences':
      return rest ? { kind: 'preferences', text: rest } : undefined;
    default:
      return { kind: 'auto_short', text: payload };
  }
}

function readFileForChat(filePath: string): { path: string; block: string; chars: number } | undefined {
  const resolved = path.resolve(expandHome(filePath));
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (error) {
    process.stderr.write(`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
  const truncated = content.length > READ_FILE_CHAR_LIMIT;
  const body = truncated ? `${content.slice(0, READ_FILE_CHAR_LIMIT)}\n[truncated at ${READ_FILE_CHAR_LIMIT} characters]` : content;
  return {
    path: resolved,
    chars: content.length,
    block: `## File: ${resolved}\n\n${body}`,
  };
}

function commandPayload(message: string, command: string): string {
  if (message === command) return '';
  return message.startsWith(`${command} `) ? message.slice(command.length + 1).trim() : '';
}

function isCommand(message: string, command: string): boolean {
  return message === command || message.startsWith(`${command} `);
}

function memoryKindLabel(kind: MemoryKind): string {
  switch (kind) {
    case 'user':
      return 'user';
    case 'preferences':
      return 'preference';
    case 'auto_short':
      return 'short-term';
    default:
      return 'profile';
  }
}

function formatMutationResult(verb: string, count: number): string {
  if (count === 0) return 'No matching memory records found.\n\n';
  return `${verb} ${count} memory record${count === 1 ? '' : 's'}.\n\n`;
}
