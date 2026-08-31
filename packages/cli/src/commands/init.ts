import { Command } from 'commander';
import {
  ConfigManager,
  MarifoldError,
  ProviderType,
  WorkspaceInitializer,
} from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { isPromptAbortError } from '../input/PromptAbort';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { resolveModelAddTarget } from '../input/ModelPicker';
import { searchUpdateFromFlags } from './config';
import { loadConfig, RootCommandOptions } from './RuntimeFactory';

interface InitOptions {
  force?: boolean;
  provider?: string;
  providerType?: string;
  model?: string;
  profile?: string;
  profilesDir?: string;
  sessionsDb?: string;
  tasksDir?: string;
  schedulesDir?: string;
  appsDir?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  searchProvider?: string;
  searchApiKeyEnv?: string;
}

// Bootstrap model written before the interactive picker overrides the default.
const BOOTSTRAP_MODEL = { provider: 'ollama', model: 'gemma4:e4b' };

export function registerInitCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('init')
    .description('Initialize Marifold config and the default profile.')
    .option('--force', 'Rewrite config.toml if it already exists.')
    .option('--provider <name>', 'Provider key to configure.', 'ollama')
    .option('--provider-type <type>', 'Provider type: ollama, openai-compatible, or anthropic.')
    .option('--model <model>', 'Default model name (skips the interactive model picker).')
    .option('--profile <name>', 'Default profile name.', 'default')
    .option('--profiles-dir <path>', 'Profiles directory.')
    .option('--sessions-db <path>', 'SQLite sessions database path.')
    .option('--tasks-dir <path>', 'Task-state directory.')
    .option('--schedules-dir <path>', 'Schedules directory.')
    .option('--apps-dir <path>', 'Apps directory.')
    .option('--base-url <url>', 'Provider base URL.')
    .option('--api-key-env <name>', 'Environment variable containing the provider API key.')
    .option('--search-provider <name>', 'Fallback web search provider: duckduckgo, firecrawl, ollama, or off.')
    .option('--search-api-key-env <name>', 'Env var holding the selected search provider API key.')
    .action(async (options: InitOptions) => {
      const rootOptions = program.opts<RootCommandOptions>();
      // Interactive only on a real terminal when the model wasn't pinned by a
      // flag — so scripts and CI (no TTY, or `--model`) keep the old behavior.
      const interactive = !options.model && Boolean(process.stdout.isTTY && process.stdin.isTTY);

      try {
        const result = new WorkspaceInitializer().initialize({
          configPath: rootOptions.config,
          force: Boolean(options.force),
          // Interactive runs bootstrap on Ollama defaults, then the picker
          // rewrites the default model (and adds the chosen provider) below.
          provider: interactive ? BOOTSTRAP_MODEL.provider : options.provider,
          providerType: interactive ? undefined : parseProviderType(options.providerType),
          model: options.model,
          profile: options.profile,
          profilesDir: options.profilesDir,
          sessionsDb: options.sessionsDb,
          tasksDir: options.tasksDir,
          schedulesDir: options.schedulesDir,
          appsDir: options.appsDir,
          baseUrl: interactive ? undefined : options.baseUrl,
          apiKeyEnv: interactive ? undefined : options.apiKeyEnv,
        });
        // In interactive mode, hide the bootstrap model line and Next steps —
        // the chosen model and next steps are printed after the picker.
        printer.printInitResult(result, interactive ? { showModel: false, showNextSteps: false } : {});

        if (interactive) {
          await runInteractiveSetup(program, printer);
          return;
        }
        if (options.searchProvider) {
          const manager = new ConfigManager(loadConfig(program));
          manager.updateWebSearch(searchUpdateFromFlags({
            provider: options.searchProvider,
            apiKeyEnv: options.searchApiKeyEnv,
          }));
          process.stdout.write(`Fallback web search: ${manager.config.webSearch?.provider ?? 'duckduckgo'}\n`);
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

/** Pick a default model (and optionally enable fallback web search) after init, so
 * a first run never points at a model the user doesn't have. Reuses the same
 * provider/model picker as `marifold model add`/`model default`. */
async function runInteractiveSetup(program: Command, printer: ConsolePrinter): Promise<void> {
  let prompt: InteractivePrompt | undefined;
  const getPrompt = (): InteractivePrompt => (prompt ??= new InteractivePrompt());
  try {
    const loadedConfig = loadConfig(program);
    const style = new TerminalStyle();

    process.stdout.write('\nChoose the model Marifold should use by default:\n');
    const { provider, model } = await resolveModelAddTarget(loadedConfig, getPrompt, style);
    const manager = new ConfigManager(loadedConfig);
    manager.addModel(provider, model);
    manager.setDefaultModel(model, provider);
    // Drop the bootstrap placeholder unless that's exactly what was chosen.
    if (provider !== BOOTSTRAP_MODEL.provider || model !== BOOTSTRAP_MODEL.model) {
      try {
        manager.removeModel(BOOTSTRAP_MODEL.provider, BOOTSTRAP_MODEL.model);
      } catch {
        // The placeholder may already be gone or be the default — leave it.
      }
    }
    process.stdout.write(style.bold(`Default model: ${provider}/${model}\n`));

    if (await readYesNo(getPrompt(), style, 'Enable fallback web search (DuckDuckGo, no API key)?', false)) {
      manager.updateWebSearch(searchUpdateFromFlags({ provider: 'duckduckgo' }));
      process.stdout.write('Fallback web search: duckduckgo\n');
    }

    process.stdout.write('\nDone. Run `marifold` to start.\n');
    process.stdout.write(style.dim('(Change the default model later with `marifold model default`.)\n'));
  } catch (error) {
    if (isPromptAbortError(error)) {
      process.stdout.write('\nLeft at defaults. Set a model later with `marifold model default`.\n');
      return;
    }
    printer.printError(error);
    process.exitCode = 1;
  } finally {
    prompt?.close();
  }
}

async function readYesNo(
  prompt: InteractivePrompt,
  style: TerminalStyle,
  label: string,
  def: boolean,
): Promise<boolean> {
  const answer = await prompt.readUserMessage(style.bold(`${label}${def ? ' [Y/n] ' : ' [y/N] '}`));
  if (answer === undefined) return def;
  const value = answer.trim().toLowerCase();
  if (!value) return def;
  return value === 'y' || value === 'yes';
}

function parseProviderType(value?: string): ProviderType | undefined {
  if (value === undefined) return undefined;
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid(
    `Expected --provider-type to be "ollama", "openai-compatible", or "anthropic".`,
  );
}
