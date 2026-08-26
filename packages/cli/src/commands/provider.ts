import { Command } from 'commander';
import {
  ConfigManager,
  getProviderRegistryEntry,
  listProviderRegistry,
  MarifoldError,
  ProviderInspector,
} from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { reauthenticateOAuthProvider } from '../input/ModelPicker';
import { isPromptAbortError, isPromptBackError, PromptAbortError } from '../input/PromptAbort';
import { selectTerminalOption } from '../input/TerminalSelect';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { loadConfig } from './RuntimeFactory';

export function registerProviderCommand(program: Command, printer: ConsolePrinter): void {
  const provider = program
    .command('provider')
    .description('Inspect configured providers.')
    .argument('[name]', 'Provider key for provider-specific actions.')
    .argument('[action]', 'Provider action. Use "list" to list live models.')
    .action(async (name: string | undefined, action: string | undefined) => {
      try {
        const inspector = new ProviderInspector(loadConfig(program));
        if (name && action === 'list') {
          const result = await inspector.listModels(name);
          if (result.models.length === 0) {
            process.stdout.write(`${result.message}\n`);
            return;
          }
          for (const model of result.models) process.stdout.write(`${model}\n`);
          return;
        }
        if (name) {
          process.stderr.write(`Unknown provider action: ${name} ${action ?? ''}`.trim() + '\n');
          process.exitCode = 1;
          return;
        }

        const current = inspector.current();
        if (!current) {
          process.stdout.write('Current provider: unset\n');
          return;
        }
        process.stdout.write(`Current provider: ${current.name} (${current.type})\n`);
        if (current.baseUrl) process.stdout.write(`Base URL: ${current.baseUrl}\n`);
        if (current.apiKeyEnv) process.stdout.write(`API key env: ${current.apiKeyEnv}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  provider
    .command('list')
    .description('List configured providers.')
    .action(() => {
      try {
        const providers = new ProviderInspector(loadConfig(program)).list();
        for (const item of providers) {
          const marker = item.isDefault ? '*' : ' ';
          const details = [
            item.type,
            item.baseUrl,
            item.apiKeyEnv ? `env:${item.apiKeyEnv}` : undefined,
          ].filter(Boolean).join(' · ');
          process.stdout.write(`${marker} ${item.name}\t${details}\n`);
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  provider
    .command('add')
    .description('Add or reconfigure a provider — e.g. point Ollama at a remote server over Tailscale.')
    .argument('[name]', 'Provider key from the registry (e.g. "ollama"). Omit for an interactive picker.')
    .option('--base-url <url>', 'Server URL (skips the prompt).')
    .option('--api-key-env <name>', 'Environment variable holding the API key (API providers).')
    .action(async (nameArg: string | undefined, options: { baseUrl?: string; apiKeyEnv?: string }) => {
      let prompt: InteractivePrompt | undefined;
      const getPrompt = (): InteractivePrompt => (prompt ??= new InteractivePrompt());
      try {
        const loadedConfig = loadConfig(program);
        const style = new TerminalStyle();

        // Wizard loop: Esc at a text prompt throws PromptBackError, which steps
        // back to the provider picker rather than cancelling the command. Esc at
        // the picker (or Ctrl+C anywhere) cancels via PromptAbortError.
        while (true) {
          const name = nameArg ?? await pickProvider(getPrompt, style);
          const entry = getProviderRegistryEntry(name);
          const existing = loadedConfig.config.providers[name];
          if (!entry && !existing) {
            throw MarifoldError.configInvalid(
              `Unknown provider '${name}'. Run 'marifold provider add' with no name to pick from the registry.`,
            );
          }
          const type = existing?.type ?? entry?.type ?? 'openai-compatible';

          // Ollama and other OpenAI-compatible servers need a base URL; this is the
          // remote-IP entry point. Anthropic uses its SDK default, so skip it there.
          const needsBaseUrl = type === 'ollama' || type === 'openai-compatible';
          const defaultBaseUrl = existing?.baseUrl ?? entry?.defaultBaseUrl;

          let baseUrl = options.baseUrl ?? defaultBaseUrl;
          let apiKeyEnv = options.apiKeyEnv ?? existing?.apiKeyEnv ?? entry?.apiKeyEnv;
          try {
            if (!options.baseUrl && needsBaseUrl) {
              baseUrl = await readLineWithDefault(getPrompt(), style, 'Server URL', defaultBaseUrl);
            }
            // For API providers, capture only the env var *name* (never the secret);
            // the user exports the key separately. OAuth sign-in stays in `model add`.
            if (!options.apiKeyEnv && entry?.kind === 'api') {
              apiKeyEnv = await readLineWithDefault(getPrompt(), style, 'API key env var', apiKeyEnv);
            }
          } catch (error) {
            // Esc stepped back. If the name came from an argument there is no
            // picker to return to, so treat it as a cancel.
            if (isPromptBackError(error)) {
              if (nameArg !== undefined) throw new PromptAbortError();
              // Release the readline interface so the next picker (raw-mode key
              // reader) owns stdin cleanly; getPrompt() lazily makes a fresh one.
              prompt?.close();
              prompt = undefined;
              process.stdout.write('\n');
              continue;
            }
            throw error;
          }

          const manager = new ConfigManager(loadedConfig);
          const savedPath = manager.addProvider(name, { baseUrl, apiKeyEnv }).configPath;
          const config = manager.config.providers[name];

          process.stdout.write(
            `${existing ? 'Updated' : 'Added'} provider ${name} (${type})${config.baseUrl ? ` → ${config.baseUrl}` : ''}\n`,
          );
          if (apiKeyEnv && entry?.kind === 'api') {
            const set = Boolean(process.env[apiKeyEnv]);
            process.stdout.write(style.dim(`API key env: ${apiKeyEnv}${set ? '' : ' (not set — export it before use)'}\n`));
          }
          process.stdout.write(style.dim(`Saved ${savedPath}\n`));

          // Confirm the server actually answers at the new URL.
          process.stdout.write('Checking reachability…\n');
          const result = await new ProviderInspector(loadedConfig).listModels(name);
          if (result.reachable === true && result.models.length > 0) {
            const sample = result.models.slice(0, 5).join(', ');
            const more = result.models.length > 5 ? ', …' : '';
            process.stdout.write(style.bold(`Reachable — ${result.models.length} model(s): ${sample}${more}\n`));
          } else if (result.reachable === false) {
            process.stdout.write(style.yellow(`Unreachable — ${result.message}\n`));
          } else {
            process.stdout.write(style.dim(`${result.message}\n`));
          }
          process.stdout.write(style.dim(`Next: marifold model add ${name}\n`));
          break;
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
      }
    });

  provider
    .command('reauth')
    .description('Replace saved credentials for a Marifold-managed OAuth provider.')
    .argument('<name>', 'OAuth provider key: github_copilot, chatgpt, or xai.')
    .action(async (name: string) => {
      let prompt: InteractivePrompt | undefined;
      const getPrompt = (): InteractivePrompt => (prompt ??= new InteractivePrompt());
      try {
        const loadedConfig = loadConfig(program);
        const style = new TerminalStyle();
        await reauthenticateOAuthProvider(loadedConfig, getPrompt, style, name);
        const savedPath = new ConfigManager(loadedConfig).save();
        process.stdout.write(`Re-authenticated provider ${name}.\n`);
        process.stdout.write(style.dim(`Saved ${savedPath}\n`));
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
      }
    });

  provider
    .command('status')
    .description('Show provider configuration and local reachability status.')
    .action(async () => {
      try {
        const statuses = await new ProviderInspector(loadConfig(program)).status();
        process.stdout.write('Provider\tConfigured\tReachable\tBase URL\tAPI Key Env\tMessage\n');
        for (const status of statuses) {
          const reachable = status.reachable === null ? 'not checked' : status.reachable ? 'reachable' : 'unreachable';
          const configured = status.configured ? 'configured' : 'not configured';
          process.stdout.write(
            `${status.name}\t${configured}\t${reachable}\t${status.baseUrl ?? ''}\t${status.apiKeyEnv ?? ''}\t${status.message}\n`,
          );
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

/** Pick a provider from the registry: an arrow-key menu on a TTY, falling back
 * to a numbered prompt (or a typed name) when raw input is unavailable. */
async function pickProvider(getPrompt: () => InteractivePrompt, style: TerminalStyle): Promise<string> {
  const registry = listProviderRegistry();
  const label = (entry: { name: string; label: string }): string => `${entry.name}  —  ${entry.label}`;

  const selected = await selectTerminalOption(
    'Select provider to add:',
    registry.map(entry => ({ label: label(entry), value: entry.name })),
    { defaultIndex: 0 },
  );
  if (selected !== undefined) return selected;

  process.stdout.write('Select provider to add:\n');
  registry.forEach((entry, index) => process.stdout.write(`  ${index + 1}. ${label(entry)}\n`));
  const answer = await getPrompt().readUserMessage(style.bold('Provider [1]: '), { onEscape: 'cancel' });
  if (answer === undefined) throw new PromptAbortError();
  const raw = answer.trim();
  if (!raw) return registry[0].name;
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= registry.length) return registry[index - 1].name;
  if (getProviderRegistryEntry(raw)) return raw;
  throw MarifoldError.configInvalid(`Unknown provider: ${raw}`);
}

/** Read one line, returning `def` on empty input. Throws if empty with no default. */
async function readLineWithDefault(
  prompt: InteractivePrompt,
  style: TerminalStyle,
  label: string,
  def?: string,
): Promise<string> {
  const answer = await prompt.readUserMessage(style.bold(`${label}${def ? ` [${def}]` : ''}: `), { onEscape: 'back' });
  if (answer === undefined) throw new PromptAbortError();
  const value = answer.trim();
  if (value) return value;
  if (def) return def;
  throw MarifoldError.configInvalid(`${label} cannot be empty.`);
}
