import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import {
  getActiveServiceProcess,
  readRecentServiceLog,
  serviceProcessPaths,
} from '../service/ServiceProcess';

interface StatusOptions {
  logs?: boolean;
}

const STATUS_LOG_LINES = 100;

export function registerStatusCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('status')
    .description('Show the managed Marifold service status.')
    .option('--logs', `Show the most recent ${STATUS_LOG_LINES} daemon log lines.`)
    .action((options: StatusOptions) => {
      try {
        const paths = serviceProcessPaths();
        const state = getActiveServiceProcess(paths);
        if (state) {
          process.stdout.write('Marifold service: running\n');
          process.stdout.write(`PID:     ${state.pid}\n`);
          process.stdout.write(`Mode:    ${state.mode}\n`);
          process.stdout.write(`Started: ${state.startedAt}\n`);
          if (state.address) process.stdout.write(`Address: ${state.address}\n`);
          process.stdout.write(`Config:  ${state.configPath}\n`);
        } else {
          process.stdout.write('Marifold service: stopped\n');
          process.exitCode = 1;
        }
        process.stdout.write(`Log:     ${paths.log}\n`);

        if (options.logs) printLogs(paths.log);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function printLogs(logPath: string): void {
  const logs = readRecentServiceLog(STATUS_LOG_LINES);
  process.stdout.write(`\nRecent logs (last ${STATUS_LOG_LINES} lines):\n`);
  if (logs === undefined) {
    process.stdout.write(`No daemon log found at ${logPath}.\n`);
  } else if (logs.length === 0) {
    process.stdout.write('(empty)\n');
  } else {
    process.stdout.write(`${logs}\n`);
  }
}
