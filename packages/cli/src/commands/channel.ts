import { Command } from 'commander';
import { ConfigManager, MarifoldError, MarifoldRuntime, type ProfileMode } from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { PromptAbortError, isPromptAbortError } from '../input/PromptAbort';
import { readSecretLine } from '../input/SecretPrompt';
import { selectTerminalOption } from '../input/TerminalSelect';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

/**
 * `marifold channel <app>` — messaging bridges. For now this is config-only
 * (`telegram setup`); the running bridge (long-poll loop) is a separate command.
 */
export function registerChannelCommand(program: Command, printer: ConsolePrinter): void {
  const channel = program.command('channel').description('Messaging channels (Telegram, …).');
  const telegram = channel.command('telegram').description('Telegram bot bridge.');

  telegram
    .command('setup')
    .description('Configure the Telegram bot: token, allowlist, profile, default mode.')
    .action(async () => {
      const loaded = loadConfig(program);
      const runtime = new MarifoldRuntime({ loadedConfig: loaded });
      const prompt = new InteractivePrompt();
      try {
        const token = await readSecretLine('Bot token (from @BotFather): ', () => prompt);
        if (!token.trim()) throw MarifoldError.configInvalid('Bot token cannot be empty.');

        const idsRaw = await prompt.readUserMessage('Allowed Telegram user id(s), comma-separated: ');
        if (idsRaw === undefined) throw new PromptAbortError();
        const allowlist = parseIds(idsRaw);
        if (allowlist.length === 0) {
          process.stderr.write('Warning: empty allowlist — the bot will respond to nobody until you add an id.\n');
        }

        const profileNames = runtime.listProfiles().map(p => p.name);
        const profile = (await selectTerminalOption(
          'Profile the bot runs as:',
          profileNames.map(name => ({ label: name, value: name })),
        )) ?? profileNames[0] ?? 'default';

        const defaultMode = ((await selectTerminalOption('Default mode for a new chat:', [
          { label: 'agent (tools)', value: 'agent' },
          { label: 'chat', value: 'chat' },
        ])) ?? 'agent') as ProfileMode;

        loaded.config.channels = {
          ...(loaded.config.channels ?? {}),
          telegram: { botToken: token.trim(), allowlist, profile, defaultMode },
        };
        const savedPath = new ConfigManager(loaded).save();

        process.stdout.write(`\nSaved [channel.telegram] to ${savedPath}.\n`);
        process.stdout.write(`  profile: ${profile} · default mode: ${defaultMode} · ${allowlist.length} allowed user(s)\n`);
        process.stdout.write('Note: the token is stored in config.toml. For better hygiene, move it to an env var and set\n');
        process.stdout.write('      bot_token_env instead of bot_token. Run `marifold doctor` to check readiness.\n');
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
}

function parseIds(raw: string): number[] {
  return [...new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0),
  )];
}
