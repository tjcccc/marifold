import { Command } from 'commander';
import { DeviceExecution, TailscaleControl } from '@marifold/core';
import { loadConfig } from './RuntimeFactory';
import type { ConsolePrinter } from '../output/ConsolePrinter';

export function registerExecutionCommand(program: Command, printer: ConsolePrinter): void {
  const group = program.command('execution').description('Configure this device’s local execution capability and inspect durable jobs.');
  const device = () => new DeviceExecution(loadConfig(program).configPath);
  const action = <Args extends unknown[]>(fn: (...args: Args) => unknown) => (...args: Args) => {
    try { process.stdout.write(`${JSON.stringify(fn(...args), null, 2)}\n`); }
    catch (error) { printer.printError(error); process.exitCode = 1; }
  };
  group.command('mode [mode]').description('Show mode, or explicitly set scoped/full on this device. Full commands still require approval; no administrator permissions are granted.')
    .action(action((mode?: string) => {
      const execution = device();
      if (mode !== undefined) {
        if (mode !== 'scoped' && mode !== 'full') { throw new Error('Expected scoped or full.'); }
        execution.setMode(mode);
      }
      return { mode: execution.mode(), note: 'Applies only to this config on this device. Already-started full-access jobs continue when disabled.' };
    }));
  group.command('jobs [id]').description('List recent jobs or retrieve a durable result by ID. Never reruns commands.')
    .action(action((id?: string) => id ? device().status(id) : device().recent()));
  group.command('tailscale <action>').description('check or restart the standalone macOS Tailscale app using existing OS permissions. For durable remote execution, invoke through shell_exec access=full.')
    .action(async (action: string) => {
      try {
        const tailscale = new TailscaleControl();
        if (action !== 'check' && action !== 'restart') { throw new Error('Expected check or restart.'); }
        if (action === 'restart' && device().mode() !== 'full') { throw new Error('Enable full execution locally before using this restart workflow.'); }
        const result = action === 'check' ? await tailscale.check() : await tailscale.restart();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if ('canRestart' in result ? !result.canRestart : !result.restarted || !result.vpnReady) { process.exitCode = 1; }
      } catch (error) { printer.printError(error); process.exitCode = 1; }
    });
}
