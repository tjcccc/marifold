import { spawn } from 'child_process';
import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';

export const NPM_UPDATE_ARGS = ['install', '--global', 'marifold@latest'] as const;

export interface UpdateCommandResult {
  exitCode: number;
  signal?: NodeJS.Signals;
}

export type UpdateCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<UpdateCommandResult>;

export interface UpdateCommandDependencies {
  runCommand?: UpdateCommandRunner;
  write?: (text: string) => void;
}

export function registerUpdateCommand(
  program: Command,
  printer: ConsolePrinter,
  dependencies: UpdateCommandDependencies = {},
): void {
  program
    .command('update')
    .description('Update marifold to the latest version published on npm.')
    .action(async () => {
      try {
        const write = dependencies.write ?? (text => process.stdout.write(text));
        const runCommand = dependencies.runCommand ?? runInheritedCommand;
        write('Running `npm install --global marifold@latest`...\n');
        const result = await runCommand(npmExecutable(), NPM_UPDATE_ARGS);
        if (result.exitCode !== 0) {
          const termination = result.signal
            ? `signal ${result.signal}`
            : `exit code ${result.exitCode}`;
          throw new Error(`npm install --global marifold@latest failed (${termination}).`);
        }
        write('Updated marifold to npm latest.\n');
        write('Restart a running service with `marifold service restart`.\n');
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

export function npmExecutable(platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runInheritedCommand(
  command: string,
  args: readonly string[],
): Promise<UpdateCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.once('error', error => {
      reject(new Error(`Could not start npm: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        ...(signal ? { signal } : {}),
      });
    });
  });
}
