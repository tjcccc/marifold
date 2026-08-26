import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ConfigLoader, MarifoldError } from '@marifold/core';
import { resolveSecurityOptions, startMarifoldService } from '@marifold/service';
import { ConsolePrinter } from '../output/ConsolePrinter';
import {
  claimServiceProcess,
  ensureServiceProcessDir,
  getActiveServiceProcess,
  markServiceProcessRunning,
  releaseServiceProcess,
  ServiceLaunchOptions,
  ServiceProcessState,
  ServiceStartupDetails,
  serviceProcessPaths,
  stopActiveServiceProcess,
} from '../service/ServiceProcess';
import {
  formatServiceAvailability,
  isLoopbackServiceHost,
  serviceBindUrl,
  serviceEntryUrls,
} from '../service/ServiceOutput';
import { loadConfig } from './RuntimeFactory';

interface ServiceOptions {
  host?: string;
  port?: string;
  log?: boolean;
  daemon?: boolean;
  verbose?: boolean;
  token?: string;
  tokenEnv?: string;
  corsOrigin?: string[];
  webDir?: string;
  /** Internal restart option; daemon children inherit this through spawn cwd. */
  cwd?: string;
}

interface ServiceRestartOptions {
  token?: string;
  verbose?: boolean;
}

const SHUTDOWN_GRACE_MS = 5_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_CHILD_ENV = 'MARIFOLD_SERVICE_DAEMON_CHILD';
const DAEMON_TOKEN_ENV = 'MARIFOLD_SERVICE_DAEMON_TOKEN';

export function registerServiceCommand(program: Command, printer: ConsolePrinter): void {
  const service = program
    .command('service')
    .description('Run and manage the local Marifold HTTP service.');

  addServiceOptions(service)
    .action(async (options: ServiceOptions) => {
      await runService(program, printer, options);
    });

  addServiceOptions(service.command('start').description('Start the Marifold service.'), true)
    .action(async (options: ServiceOptions) => {
      if (options.daemon) {
        await startDaemon(program, printer, options);
      } else {
        await runService(program, printer, options);
      }
    });

  service
    .command('stop')
    .description('Stop the managed Marifold service.')
    .action(async () => {
      try {
        const stopped = await stopActiveServiceProcess();
        if (stopped) {
          process.stdout.write(`Marifold service stopped (PID ${stopped.pid}).\n`);
        } else {
          process.stdout.write('Marifold service is not running.\n');
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  service
    .command('restart')
    .description('Restart the managed service with its previous launch options.')
    .option('--token <token>', 'Raw bearer token required again when the previous start used --token.')
    .option('--verbose', 'Show technical service details.')
    .action(async (options: ServiceRestartOptions) => {
      await restartService(program, printer, options);
    });
}

function addServiceOptions(command: Command, allowDaemon = false): Command {
  command
    .option('--host <host>', 'Host to bind. Non-loopback binds accept private LAN and overlay-network clients only.', '127.0.0.1')
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
    .option('--web-dir <dir>', 'Host the built Web UI from this directory (overrides [service].web_dir).');
  command.option('--verbose', 'Show technical service details.');
  if (allowDaemon) command.option('--daemon', 'Run the service in the background.');
  return command;
}

async function runService(
  program: Command,
  printer: ConsolePrinter,
  options: ServiceOptions,
  configPath?: string,
): Promise<void> {
  let owner: ReturnType<typeof claimServiceProcess> | undefined;
  try {
    if (options.cwd) process.chdir(options.cwd);
    const loadedConfig = loadServiceConfig(program, configPath);
    const daemonChild = process.env[DAEMON_CHILD_ENV] === '1';
    const rawToken = Boolean(options.token || (daemonChild && options.tokenEnv === DAEMON_TOKEN_ENV));
    const token = resolveTokenFlags(options);
    if (daemonChild) {
      delete process.env[DAEMON_CHILD_ENV];
      if (options.tokenEnv === DAEMON_TOKEN_ENV) delete process.env[DAEMON_TOKEN_ENV];
    }
    const corsOrigins = options.corsOrigin && options.corsOrigin.length > 0 ? options.corsOrigin : undefined;
    const webDir = options.webDir ? path.resolve(options.webDir) : undefined;
    const security = resolveSecurityOptions(loadedConfig.config.service, { token, corsOrigins });
    const mode = daemonChild ? 'daemon' : 'foreground';
    owner = claimServiceProcess(
      mode,
      loadedConfig.configPath,
      serviceProcessPaths(),
      serviceLaunchOptions(options, rawToken),
    );
    const result = await startMarifoldService({
      loadedConfig,
      host: options.host,
      port: parsePort(options.port),
      logger: Boolean(options.log),
      auth: { token },
      cors: { origins: corsOrigins },
      web: { dir: webDir },
    });
    const startup = {
      ...(result.telegram ? { telegramProfile: result.telegram.profile } : {}),
      ...(result.webDir ? { webDir: result.webDir } : {}),
      authRequired: Boolean(security.token),
      corsOrigins: security.corsOrigins,
    };
    markServiceProcessRunning(owner, { address: result.address, startup });

    printServiceAvailability(result.address, result.host);
    printServiceDetails({
      startup,
      host: result.host,
      address: result.address,
      configPath: loadedConfig.configPath,
      requestLogging: Boolean(options.log),
      verbose: Boolean(options.verbose),
    });
    if (mode === 'foreground') process.stdout.write('Press Ctrl+C to stop.\n');
    await waitForShutdown({
      close: result.server.close.bind(result.server),
      forceClose: () => {
        result.server.server.closeIdleConnections?.();
        result.server.server.closeAllConnections?.();
      },
      onFinish: () => {
        if (owner) releaseServiceProcess(owner);
      },
    });
  } catch (error) {
    printer.printError(error);
    process.exitCode = 1;
  } finally {
    if (owner) releaseServiceProcess(owner);
  }
}

async function startDaemon(
  program: Command,
  printer: ConsolePrinter,
  options: ServiceOptions,
  configPath?: string,
): Promise<void> {
  try {
    const loadedConfig = loadServiceConfig(program, configPath);
    resolveTokenFlags(options);
    parsePort(options.port);

    const existing = getActiveServiceProcess();
    if (existing) throw new Error(`Marifold service is already running (PID ${existing.pid}, ${existing.mode}).`);

    const paths = serviceProcessPaths();
    ensureServiceProcessDir(paths);
    const logFd = fs.openSync(paths.log, 'a', 0o600);
    let daemon: ChildProcess;
    try {
      daemon = spawn(process.execPath, buildDaemonArgs(loadedConfig.configPath, options), {
        cwd: options.cwd ?? process.cwd(),
        detached: true,
        env: buildDaemonEnv(options),
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }

    const state = await waitForDaemonStart(daemon, DAEMON_START_TIMEOUT_MS);
    daemon.unref();
    if (state.address) printServiceAvailability(state.address, state.launch?.host);
    process.stdout.write(`Marifold service started in background (PID ${state.pid}).\n`);
    if (state.address && state.startup) {
      printServiceDetails({
        startup: state.startup,
        host: state.launch?.host ?? new URL(state.address).hostname,
        address: state.address,
        configPath: state.configPath,
        requestLogging: Boolean(state.launch?.log),
        verbose: Boolean(options.verbose),
      });
    }
    process.stdout.write(`Log: ${paths.log}\n`);
  } catch (error) {
    printer.printError(error);
    process.exitCode = 1;
  }
}

function buildDaemonArgs(configPath: string, options: ServiceOptions): string[] {
  const args = [path.resolve(__dirname, '../index.js')];
  args.push('--config', configPath);
  args.push('service', 'start');
  args.push('--host', options.host ?? '127.0.0.1');
  args.push('--port', options.port ?? '32140');
  if (options.log) args.push('--log');
  if (options.verbose) args.push('--verbose');
  if (options.token) {
    args.push('--token-env', DAEMON_TOKEN_ENV);
  } else if (options.tokenEnv) {
    args.push('--token-env', options.tokenEnv);
  }
  for (const origin of options.corsOrigin ?? []) args.push('--cors-origin', origin);
  if (options.webDir) args.push('--web-dir', path.resolve(options.webDir));
  return args;
}

async function restartService(
  program: Command,
  printer: ConsolePrinter,
  restartOptions: ServiceRestartOptions,
): Promise<void> {
  try {
    const active = getActiveServiceProcess();
    if (!active) throw new Error('Marifold service is not running.');
    if (!active.launch) {
      throw new Error(
        'The running service has no saved restart options. Stop it and start it once with this Marifold version.',
      );
    }

    const options = serviceOptionsForRestart(active.launch, restartOptions.token, restartOptions.verbose);
    if (!fs.existsSync(active.launch.cwd)) {
      throw new Error(`Previous service working directory no longer exists: ${active.launch.cwd}`);
    }
    loadServiceConfig(program, active.configPath);
    resolveTokenFlags(options);
    parsePort(options.port);

    const stopped = await stopActiveServiceProcess();
    if (!stopped) throw new Error('Marifold service stopped before restart could claim it.');
    process.stdout.write(`Marifold service stopped (PID ${stopped.pid}). Restarting...\n`);

    if (active.mode === 'daemon') {
      await startDaemon(program, printer, options, active.configPath);
    } else {
      await runService(program, printer, options, active.configPath);
    }
  } catch (error) {
    printer.printError(error);
    process.exitCode = 1;
  }
}

function serviceLaunchOptions(options: ServiceOptions, rawToken: boolean): ServiceLaunchOptions {
  const tokenSource = rawToken ? 'raw' : options.tokenEnv ? 'env' : 'config';
  return {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? '32140',
    cwd: options.cwd ?? process.cwd(),
    log: Boolean(options.log),
    corsOrigins: [...(options.corsOrigin ?? [])],
    ...(options.webDir ? { webDir: path.resolve(options.webDir) } : {}),
    tokenSource,
    ...(tokenSource === 'env' && options.tokenEnv ? { tokenEnv: options.tokenEnv } : {}),
  };
}

function serviceOptionsForRestart(launch: ServiceLaunchOptions, token?: string, verbose?: boolean): ServiceOptions {
  if (launch.tokenSource === 'raw' && !token) {
    throw MarifoldError.configInvalid(
      'The service was started with --token. Restart it with marifold service restart --token <token>.',
    );
  }
  return {
    host: launch.host,
    port: launch.port,
    cwd: launch.cwd,
    log: launch.log,
    verbose,
    corsOrigin: [...launch.corsOrigins],
    webDir: launch.webDir,
    ...(token ? { token } : {}),
    ...(!token && launch.tokenSource === 'env' && launch.tokenEnv ? { tokenEnv: launch.tokenEnv } : {}),
  };
}

interface ServiceDetailsOptions {
  startup: ServiceStartupDetails;
  host: string;
  address: string;
  configPath: string;
  requestLogging: boolean;
  verbose: boolean;
}

function printServiceAvailability(address: string, host?: string): void {
  process.stdout.write(`${formatServiceAvailability(serviceEntryUrls(address, host))}\n`);
}

function printServiceDetails(options: ServiceDetailsOptions): void {
  if (options.startup.telegramProfile) {
    process.stdout.write(`Telegram bridge active (profile ${options.startup.telegramProfile}).\n`);
  }
  if (options.startup.authRequired) {
    process.stdout.write('Auth: bearer token required on /v1 (exempt: /health, static).\n');
  }
  if (!isLoopbackServiceHost(options.host)) {
    process.stdout.write('Access: private networks only (LAN, link-local, and Tailscale).\n');
  }
  if (!options.verbose) return;

  process.stdout.write(`Bind: ${serviceBindUrl(options.address, options.host)}\n`);
  if (options.startup.webDir) process.stdout.write(`Web UI: serving ${options.startup.webDir}\n`);
  if (options.startup.corsOrigins.length > 0) {
    process.stdout.write(`CORS: allowing ${options.startup.corsOrigins.join(', ')}\n`);
  }
  process.stdout.write(`Config: ${options.configPath}\n`);
  process.stdout.write(`HTTP request logging: ${options.requestLogging ? 'enabled' : 'disabled'}\n`);
}

function loadServiceConfig(program: Command, configPath?: string) {
  return configPath ? new ConfigLoader().load({ configPath }) : loadConfig(program);
}

function buildDaemonEnv(options: ServiceOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [DAEMON_CHILD_ENV]: '1',
    ...(options.token ? { [DAEMON_TOKEN_ENV]: options.token } : {}),
  };
}

function waitForDaemonStart(child: ChildProcess, timeoutMs: number): Promise<ServiceProcessState> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
    };
    const check = (): void => {
      if (settled) return;
      try {
        const state = getActiveServiceProcess();
        if (state && state.pid === child.pid && state.status === 'running') {
          finish();
          resolve(state);
        } else if (Date.now() >= deadline) {
          child.kill('SIGTERM');
          finish(new Error(`Timed out starting the Marifold daemon. See ${serviceProcessPaths().log}.`));
        }
      } catch (error) {
        child.kill('SIGTERM');
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`Marifold daemon exited during startup (code=${code}, signal=${signal}). See ${serviceProcessPaths().log}.`));
    };
    const timer = setInterval(check, 50);
    child.once('error', onError);
    child.once('exit', onExit);
    check();
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
  onFinish?: () => void;
  /** Test seam. Production deliberately exits after cleanup so a stray SDK
   * handle cannot keep `marifold service` alive after Ctrl+C. */
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
      try {
        options.onFinish?.();
      } catch (error) {
        process.stderr.write(`Service process-state cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
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
