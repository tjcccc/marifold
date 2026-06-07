import { Command } from 'commander';
import {
  MarifoldError,
  ProviderType,
  WorkspaceInitializer,
} from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { RootCommandOptions } from './RuntimeFactory';

interface InitOptions {
  force?: boolean;
  provider?: string;
  providerType?: string;
  model?: string;
  profile?: string;
  profilesDir?: string;
  sessionsDb?: string;
  tasksDir?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export function registerInitCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('init')
    .description('Initialize Marifold config and the default profile.')
    .option('--force', 'Rewrite config.toml if it already exists.')
    .option('--provider <name>', 'Provider key to configure.', 'ollama')
    .option('--provider-type <type>', 'Provider type: ollama, openai-compatible, or anthropic.')
    .option('--model <model>', 'Default model name.')
    .option('--profile <name>', 'Default profile name.', 'default')
    .option('--profiles-dir <path>', 'Profiles directory.')
    .option('--sessions-db <path>', 'SQLite sessions database path.')
    .option('--tasks-dir <path>', 'Task-state directory.')
    .option('--base-url <url>', 'Provider base URL.')
    .option('--api-key-env <name>', 'Environment variable containing the provider API key.')
    .action((options: InitOptions) => {
      const rootOptions = program.opts<RootCommandOptions>();

      try {
        const result = new WorkspaceInitializer().initialize({
          configPath: rootOptions.config,
          force: Boolean(options.force),
          provider: options.provider,
          providerType: parseProviderType(options.providerType),
          model: options.model,
          profile: options.profile,
          profilesDir: options.profilesDir,
          sessionsDb: options.sessionsDb,
          tasksDir: options.tasksDir,
          baseUrl: options.baseUrl,
          apiKeyEnv: options.apiKeyEnv,
        });
        printer.printInitResult(result);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function parseProviderType(value?: string): ProviderType | undefined {
  if (value === undefined) return undefined;
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid(
    `Expected --provider-type to be "ollama", "openai-compatible", or "anthropic".`,
  );
}
