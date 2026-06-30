import { Command } from 'commander';
import { MarifoldError } from '@marifold/core';
import { startMarifoldService } from '@marifold/service';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

interface ServiceOptions {
  host?: string;
  port?: string;
  log?: boolean;
}

export function registerServiceCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('service')
    .description('Start the local Marifold HTTP service.')
    .option('--host <host>', 'Loopback host to bind.', '127.0.0.1')
    .option('--port <number>', 'Port to bind. Use 0 for a random open port.', '32140')
    .option('--log', 'Enable HTTP request logging.')
    .action(async (options: ServiceOptions) => {
      try {
        const result = await startMarifoldService({
          loadedConfig: loadConfig(program),
          host: options.host,
          port: parsePort(options.port),
          logger: Boolean(options.log),
        });

        process.stdout.write(`Marifold service listening at ${result.address}\n`);
        if (result.telegram) {
          process.stdout.write(`Telegram bridge active (profile ${result.telegram.profile}).\n`);
        }
        process.stdout.write('Press Ctrl+C to stop.\n');
        await waitForShutdown(result.server.close.bind(result.server));
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function parsePort(value?: string): number {
  const port = Number.parseInt(value ?? '32140', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw MarifoldError.configInvalid('--port must be an integer from 0 to 65535.');
  }
  return port;
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise(resolve => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await close();
      resolve();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
