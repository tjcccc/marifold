import { Command } from 'commander';
import {
  ConfigManager,
  exportConfigBackup,
  importConfigBackup,
  MarifoldError,
  MarifoldWebSearchConfig,
  renderMarifoldConfig,
} from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { isPromptAbortError, PromptAbortError } from '../input/PromptAbort';
import { readSecretLine } from '../input/SecretPrompt';
import { selectTerminalOption } from '../input/TerminalSelect';
import { TerminalStyle } from '../output/TerminalStyle';
import { loadConfig } from './RuntimeFactory';

interface ConfigExportOptions {
  includeSessions?: boolean;
}

interface ConfigImportOptions {
  force?: boolean;
}

export function registerConfigCommand(program: Command, printer: ConsolePrinter): void {
  const config = program
    .command('config')
    .description('Inspect and update Marifold configuration.');

  config
    .command('show')
    .description('Print the resolved Marifold config.')
    .action(() => {
      try {
        const loadedConfig = loadConfig(program);
        process.stdout.write(renderMarifoldConfig(loadedConfig.config));
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('set')
    .description('Set a config value by dotted key.')
    .argument('<key>', 'Dotted config key, e.g. default.model.')
    .argument('<value>', 'Value to write.')
    .action((key: string, value: string) => {
      try {
        const result = new ConfigManager(loadConfig(program)).setValue(key, value);
        process.stdout.write(`Set ${result.key} = ${result.value}\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('export')
    .description('Export local config, profiles, memories, and optionally sessions to a backup file.')
    .argument('<file>', 'Backup file path.')
    .option('--include-sessions', 'Include the SQLite sessions database in the backup.')
    .action((file: string, options: ConfigExportOptions) => {
      try {
        const result = exportConfigBackup(loadConfig(program), file, {
          includeSessions: options.includeSessions,
        });
        process.stdout.write(`Exported config backup to ${result.path}\n`);
        process.stdout.write(`Profile files: ${result.profileFileCount}\n`);
        process.stdout.write(`Sessions: ${result.includedSessions ? 'included' : 'not included'}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('import')
    .description('Import a Marifold config backup file.')
    .argument('<file>', 'Backup file path.')
    .option('--force', 'Overwrite existing config, profile files, and sessions database.')
    .action((file: string, options: ConfigImportOptions) => {
      try {
        const result = importConfigBackup(loadConfig(program), file, {
          force: options.force,
        });
        process.stdout.write(`Imported config backup to ${result.configPath}\n`);
        process.stdout.write(`Profile files: ${result.profileFileCount}\n`);
        process.stdout.write(`Sessions: ${result.restoredSessions ? 'restored' : 'not included'}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  config
    .command('search')
    .description('Configure the web-search provider the model uses (duckduckgo or firecrawl).')
    .option('--provider <name>', 'duckduckgo, firecrawl, or off.')
    .option('--api-key-env <name>', 'Env var holding the Firecrawl API key (preferred over storing it).')
    .option('--scrape', 'Firecrawl: scrape each result into markdown (costs more).')
    .option('--enable', 'Enable model-initiated search.')
    .option('--disable', 'Disable model-initiated search.')
    .action(async (options: ConfigSearchOptions) => {
      let prompt: InteractivePrompt | undefined;
      try {
        const manager = new ConfigManager(loadConfig(program));
        const style = new TerminalStyle();
        const getPrompt = (): InteractivePrompt => (prompt ??= new InteractivePrompt());
        const update = await resolveSearchUpdate(options, getPrompt, style);
        const result = manager.updateWebSearch(update);
        printSearchSummary(manager.config.webSearch);
        process.stdout.write(`Saved ${result.configPath}\n`);
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
}

interface ConfigSearchOptions {
  provider?: string;
  apiKeyEnv?: string;
  scrape?: boolean;
  enable?: boolean;
  disable?: boolean;
}

/** Build the [web_search] changes from flags (non-interactive) or prompts. */
export async function resolveSearchUpdate(
  options: ConfigSearchOptions,
  getPrompt: () => InteractivePrompt,
  style: TerminalStyle,
): Promise<Partial<MarifoldWebSearchConfig>> {
  const flagDriven = options.provider !== undefined || options.apiKeyEnv !== undefined
    || Boolean(options.scrape) || Boolean(options.enable) || Boolean(options.disable);
  return flagDriven ? searchUpdateFromFlags(options) : searchUpdateInteractive(getPrompt, style);
}

export function searchUpdateFromFlags(options: ConfigSearchOptions): Partial<MarifoldWebSearchConfig> {
  const update: Partial<MarifoldWebSearchConfig> = {};
  const provider = options.provider?.toLowerCase();
  if (provider === 'off') {
    update.enabled = false;
  } else if (provider === 'duckduckgo' || provider === 'firecrawl') {
    update.provider = provider;
    update.enabled = true;
  } else if (provider !== undefined) {
    throw MarifoldError.configInvalid('Expected --provider to be "duckduckgo", "firecrawl", or "off".');
  }
  if (options.apiKeyEnv) update.apiKeyEnv = options.apiKeyEnv;
  if (options.scrape) update.scrape = true;
  if (options.enable) update.enabled = true;
  if (options.disable) update.enabled = false;
  return update;
}

async function searchUpdateInteractive(
  getPrompt: () => InteractivePrompt,
  style: TerminalStyle,
): Promise<Partial<MarifoldWebSearchConfig>> {
  const provider = await pickOption(getPrompt, style, 'Web search provider:', [
    { label: 'DuckDuckGo — keyless, best-effort (default)', value: 'duckduckgo' as const },
    { label: 'Firecrawl — AI-ready results (needs an API key)', value: 'firecrawl' as const },
    { label: 'Off — disable model-initiated search', value: 'off' as const },
  ]);
  if (provider === 'off') return { enabled: false };
  if (provider === 'duckduckgo') return { provider: 'duckduckgo', enabled: true };

  const update: Partial<MarifoldWebSearchConfig> = { provider: 'firecrawl', enabled: true };
  const keySource = await pickOption(getPrompt, style, 'Firecrawl API key:', [
    { label: 'Env var (recommended)', value: 'env' as const },
    { label: 'Paste key now (stored in config)', value: 'paste' as const },
    { label: 'Keyless (rate-limited)', value: 'keyless' as const },
  ]);
  if (keySource === 'env') {
    const name = await readLine(getPrompt(), style, 'Env var name [FIRECRAWL_API_KEY]: ');
    update.apiKeyEnv = name || 'FIRECRAWL_API_KEY';
  } else if (keySource === 'paste') {
    const key = await readSecretLine(style.bold('Firecrawl API key: '), getPrompt);
    if (key) update.apiKey = key;
  }
  const scrape = await pickOption(getPrompt, style, 'Scrape results into markdown (costs more)?', [
    { label: 'No — titles + snippets (cheaper)', value: 'no' as const },
    { label: 'Yes — full page markdown for the model', value: 'yes' as const },
  ]);
  update.scrape = scrape === 'yes';
  return update;
}

async function pickOption<T extends string>(
  getPrompt: () => InteractivePrompt,
  style: TerminalStyle,
  message: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  const selected = await selectTerminalOption(message, options);
  if (selected !== undefined) return selected;
  // Non-interactive fallback: numbered prompt.
  process.stdout.write(`${message}\n`);
  options.forEach((option, index) => process.stdout.write(`  ${index + 1}. ${option.label}\n`));
  const answer = await getPrompt().readUserMessage(style.bold('Choice [1]: '));
  if (answer === undefined) throw new PromptAbortError();
  const raw = answer.trim();
  const index = raw ? Number(raw) : 1;
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
  throw MarifoldError.configInvalid('Invalid selection.');
}

async function readLine(prompt: InteractivePrompt, style: TerminalStyle, label: string): Promise<string> {
  const answer = await prompt.readUserMessage(style.bold(label));
  if (answer === undefined) throw new PromptAbortError();
  return answer.trim();
}

function printSearchSummary(config: MarifoldWebSearchConfig | undefined): void {
  if (!config) return;
  process.stdout.write(`Web search: ${config.provider}${config.enabled ? '' : ' (model-initiated search off)'}\n`);
  if (config.provider === 'firecrawl') {
    const key = config.apiKeyEnv ? `env ${config.apiKeyEnv}` : config.apiKey ? 'stored in config' : 'keyless (rate-limited)';
    process.stdout.write(`  key: ${key}\n  scrape: ${config.scrape ? 'on' : 'off'}\n`);
  }
}
