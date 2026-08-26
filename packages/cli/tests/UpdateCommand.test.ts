import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NPM_UPDATE_ARGS,
  npmExecutable,
  registerUpdateCommand,
} from '../src/commands/update';
import { ConsolePrinter } from '../src/output/ConsolePrinter';

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe('marifold update', () => {
  it('runs the single npm global-install command and prints the restart reminder', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const output: string[] = [];
    const program = new Command().name('marifold').version('0.61.0');
    registerUpdateCommand(program, new ConsolePrinter(), {
      write: text => output.push(text),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0 };
      },
    });

    await program.parseAsync(['node', 'marifold', 'update']);

    expect(calls).toEqual([{ command: npmExecutable(), args: NPM_UPDATE_ARGS }]);
    expect(output.join('')).toContain('npm install --global marifold@latest');
    expect(output.join('')).toContain('Updated marifold to npm latest');
    expect(output.join('')).toContain('marifold service restart');
  });

  it('reports npm failure through the normal CLI error path', async () => {
    const printer = new ConsolePrinter();
    const printError = vi.spyOn(printer, 'printError').mockImplementation(() => undefined);
    const program = new Command().name('marifold').version('0.61.0');
    registerUpdateCommand(program, printer, {
      write: () => undefined,
      runCommand: async () => ({ exitCode: 7 }),
    });

    await program.parseAsync(['node', 'marifold', 'update']);

    expect(printError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'npm install --global marifold@latest failed (exit code 7).',
    }));
    expect(process.exitCode).toBe(1);
  });

  it('uses the npm command shim on Windows', () => {
    expect(npmExecutable('win32')).toBe('npm.cmd');
    expect(npmExecutable('darwin')).toBe('npm');
  });
});
