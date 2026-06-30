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
      // Open the readline-backed prompt lazily and only around the free-text
      // read below: a live readline interface fights the raw-mode pickers/secret
      // reads over stdin, leaving the next read to return EOF immediately.
      let prompt: InteractivePrompt | undefined;
      const getPrompt = (): InteractivePrompt => (prompt ??= new InteractivePrompt());
      try {
        // Re-running `setup` edits the single [channel.telegram] entry: every
        // prompt defaults to the current value so you can change one field
        // (e.g. the profile) without re-entering the rest.
        const existing = loaded.config.channels?.telegram;

        // Profile — preselect the current one on re-run, else `default` (the
        // profile `marifold init` guarantees), else the first available.
        const profileNames = runtime.listProfiles().map(p => p.name);
        const defaultProfileIndex = Math.max(0,
          existing?.profile && profileNames.includes(existing.profile)
            ? profileNames.indexOf(existing.profile)
            : profileNames.indexOf('default'),
        );
        const profile = (await selectTerminalOption(
          'Profile the bot runs as:',
          profileNames.map(name => ({ label: name === existing?.profile ? `${name} (current)` : name, value: name })),
          { defaultIndex: defaultProfileIndex },
        )) ?? existing?.profile ?? profileNames[defaultProfileIndex] ?? 'default';

        // Token — keep the existing one (and its source) on an empty enter.
        const hasToken = Boolean(existing?.botToken || existing?.botTokenEnv);
        const tokenInput = await readSecretLine(
          hasToken ? 'Bot token (from @BotFather) [Enter to keep existing]: ' : 'Bot token (from @BotFather): ',
          getPrompt,
        );
        let tokenFields: { botToken?: string; botTokenEnv?: string };
        if (tokenInput.trim()) {
          tokenFields = { botToken: tokenInput.trim() }; // new inline token wins; drop any prior env source
        } else if (hasToken) {
          tokenFields = {
            ...(existing?.botToken ? { botToken: existing.botToken } : {}),
            ...(existing?.botTokenEnv ? { botTokenEnv: existing.botTokenEnv } : {}),
          };
        } else {
          throw MarifoldError.configInvalid('Bot token cannot be empty.');
        }

        // Allowlist — keep on empty enter when one already exists. Open the
        // readline prompt only here and close it immediately so it never overlaps
        // the raw-mode pickers before/after (which would swallow stdin).
        const hasAllowlist = (existing?.allowlist?.length ?? 0) > 0;
        const allowlistPrompt = getPrompt();
        const idsRaw = await allowlistPrompt.readUserMessage(
          hasAllowlist
            ? `Allowed Telegram user id(s) [Enter to keep: ${existing!.allowlist.join(', ')}]: `
            : 'Allowed Telegram user id(s), comma-separated: ',
        );
        allowlistPrompt.close();
        prompt = undefined;
        if (idsRaw === undefined) throw new PromptAbortError();
        const allowlist = idsRaw.trim() ? parseIds(idsRaw) : (existing?.allowlist ?? []);
        if (allowlist.length === 0) {
          process.stderr.write('Warning: empty allowlist — the bot will respond to nobody until you add an id.\n');
        }

        // Default mode — preselect the current one on re-run.
        const defaultMode = ((await selectTerminalOption('Default mode for a new chat:', [
          { label: existing?.defaultMode === 'agent' ? 'agent (tools, current)' : 'agent (tools)', value: 'agent' },
          { label: existing?.defaultMode === 'chat' ? 'chat (current)' : 'chat', value: 'chat' },
        ], { defaultIndex: existing?.defaultMode === 'chat' ? 1 : 0 })) ?? existing?.defaultMode ?? 'agent') as ProfileMode;

        loaded.config.channels = {
          ...(loaded.config.channels ?? {}),
          telegram: {
            ...(existing?.enabled !== undefined ? { enabled: existing.enabled } : {}),
            ...tokenFields,
            allowlist,
            profile,
            defaultMode,
          },
        };
        const savedPath = new ConfigManager(loaded).save();

        const tokenNote = tokenInput.trim() ? 'updated' : 'kept';
        process.stdout.write(`\nSaved [channel.telegram] to ${savedPath}.\n`);
        process.stdout.write(`  profile: ${profile} · default mode: ${defaultMode} · ${allowlist.length} allowed user(s) · token ${tokenNote}\n`);
        if (tokenFields.botToken) {
          process.stdout.write('Note: the token is stored in config.toml. For better hygiene, move it to an env var and set\n');
          process.stdout.write('      bot_token_env instead of bot_token. Run `marifold doctor` to check readiness.\n');
        }
      } catch (error) {
        if (isPromptAbortError(error)) {
          process.stderr.write('Aborted.\n');
          process.exitCode = 130;
          return;
        }
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt?.close();
        runtime.close();
      }
    });
}

function parseIds(raw: string): number[] {
  return [...new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0),
  )];
}
