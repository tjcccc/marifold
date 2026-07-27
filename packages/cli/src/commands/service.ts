import * as path from 'path';
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
  webDir?: string;
}

const SHUTDOWN_GRACE_MS = 5_000;

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
      'Allow this browser origin (repeatable), e.g. http://127.0.0.1:5173.',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--web-dir <dir>', 'Host the built Web UI from this directory (overrides [service].web_dir).')
    .action(async (options: ServiceOptions) => {
      try {
        const loadedConfig = loadConfig(program);
        const token = resolveTokenFlags(options);
        const corsOrigins = options.corsOrigin && options.corsOrigin.length > 0 ? options.corsOrigin : undefined;
        const webDir = options.webDir ? path.resolve(options.webDir) : undefined;
        const result = await startMarifoldService({
          loadedConfig,
          host: options.host,
          port: parsePort(options.port),
          logger: Boolean(options.log),
          auth: { token },
          cors: { origins: corsOrigins },
          web: { dir: webDir },
        });

        process.stdout.write(`Marifold service listening at ${result.address}\n`);
        if (result.telegram) {
          process.stdout.write(`Telegram bridge active (profile ${result.telegram.profile}).\n`);
        }
        const servedWebDir = webDir ?? loadedConfig.config.service?.webDir;
        if (servedWebDir) process.stdout.write(`Web UI: serving ${servedWebDir}\n`);
        const security = resolveSecurityOptions(loadedConfig.config.service, { token, corsOrigins });
        if (security.token) process.stdout.write('Auth: bearer token required on /v1 (exempt: /health, static).\n');
        if (security.corsOrigins.length > 0) {
          process.stdout.write(`CORS: allowing ${security.corsOrigins.join(', ')}\n`);
        }
        process.stdout.write('Press Ctrl+C to stop.\n');
        await waitForShutdown({
          close: result.server.close.bind(result.server),
          forceClose: () => {
            result.server.server.closeIdleConnections?.();
            result.server.server.closeAllConnections?.();
          },
        });
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

interface ShutdownOptions {
  close: () => Promise<void>;
  forceClose?: () => void;
  graceMs?: number;
  /** Test seam. Production deliberately exits after cleanup so a stray SDK
   * handle cannot keep `pnpm marifold service` alive after Ctrl+C. */
  terminate?: (code: number) => void;
}

export function waitForShutdown(options: ShutdownOptions): Promise<void> {
  return new Promise(resolve => {
    let shuttingDown = false;
    let finished = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const terminate = options.terminate ?? (code => process.exit(code));
    const cleanup = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
      terminate(code);
    };
    const force = (message: string, code: number): void => {
      if (finished) return;
      process.stderr.write(`${message}\n`);
      try {
        options.forceClose?.();
      } finally {
        finish(code);
      }
    };
    const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
      if (shuttingDown) {
        force('Second shutdown signal received; forcing service termination.', 130);
        return;
      }
      shuttingDown = true;
      process.stdout.write(`Stopping Marifold service (${signal})...\n`);
      forceTimer = setTimeout(() => {
        force(`Service did not stop within ${options.graceMs ?? SHUTDOWN_GRACE_MS}ms; forcing termination.`, 1);
      }, options.graceMs ?? SHUTDOWN_GRACE_MS);
      try {
        await options.close();
        finish(0);
      } catch (error) {
        force(`Service cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 1);
      }
    };
    const onSigint = (): void => { void shutdown('SIGINT'); };
    const onSigterm = (): void => { void shutdown('SIGTERM'); };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
}
