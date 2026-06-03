import { Command } from 'commander';
import { ProviderInspector } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
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
