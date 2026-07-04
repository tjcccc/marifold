import { Command } from 'commander';
import { MarifoldError } from '@marifold/core';
import { resolveSecurityOptions, startMarifoldService } from '@marifold/service';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { loadConfig } from './RuntimeFactory';

interface ServiceOptions {
  host?: string;
  port?: string;
  log?: boolean;
  token?: string;
  tokenEnv?: string;
  corsOrigin?: string[];
}

export function registerServiceCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('service')
    .description('Start the local Marifold HTTP service.')
    .option('--host <host>', 'Loopback host to bind.', '127.0.0.1')
    .option('--port <number>', 'Port to bind. Use 0 for a random open port.', '32140')
    .option('--log', 'Enable HTTP request logging.')
    .option('--token <token>', 'Require this bearer token on API requests (prefer --token-env).')
    .option('--token-env <name>', 'Require the bearer token held in this environment variable.')
    .option(
      '--cors-origin <origin>',
      'Allow this browser origin (repeatable), e.g. http://localhost:5173.',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (options: ServiceOptions) => {
      try {
        const loadedConfig = loadConfig(program);
        const token = resolveTokenFlags(options);
        const corsOrigins = options.corsOrigin && options.corsOrigin.length > 0 ? options.corsOrigin : undefined;
        const result = await startMarifoldService({
          loadedConfig,
          host: options.host,
          port: parsePort(options.port),
          logger: Boolean(options.log),
          auth: { token },
          cors: { origins: corsOrigins },
        });

        process.stdout.write(`Marifold service listening at ${result.address}\n`);
        if (result.telegram) {
          process.stdout.write(`Telegram bridge active (profile ${result.telegram.profile}).\n`);
        }
        const security = resolveSecurityOptions(loadedConfig.config.service, { token, corsOrigins });
        if (security.token) process.stdout.write('Auth: bearer token required (exempt: /health).\n');
        if (security.corsOrigins.length > 0) {
          process.stdout.write(`CORS: allowing ${security.corsOrigins.join(', ')}\n`);
        }
        process.stdout.write('Press Ctrl+C to stop.\n');
        await waitForShutdown(result.server.close.bind(result.server));
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function resolveTokenFlags(options: ServiceOptions): string | undefined {
  if (options.token) return options.token;
  if (options.tokenEnv) {
    const token = process.env[options.tokenEnv];
    if (!token) throw MarifoldError.configInvalid(`--token-env ${options.tokenEnv} is not set in the environment.`);
    return token;
  }
  return undefined;
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
