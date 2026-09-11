import { workspaceClient } from './WorkspaceClient';
import type { MarifoldRuntime } from '@marifold/core';
import { Command } from 'commander';
import { ScheduleState } from '@marifold/core';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { createRuntime } from './RuntimeFactory';

interface ScheduleAddOptions {
  name?: string;
  cron: string;
  profile?: string;
  disabled?: boolean;
}

export function registerScheduleCommand(program: Command, printer: ConsolePrinter): void {
  const schedule = program
    .command('schedule')
    .option('--workspace <nameOrId>', 'Use a saved workspace, or local.')
    .description('Manage scheduled agent runs. Schedules fire while marifold service is running.');

  schedule
    .command('add')
    .description('Create a scheduled agent run.')
    .argument('<objective...>', 'Agent objective to run on the schedule.')
    .requiredOption('--cron <expression>', 'Cron expression, e.g. "0 9 * * 1-5".')
    .option('--name <name>', 'Display name. Defaults to the objective.')
    .option('--profile <name>', 'Profile to run the agent with.')
    .option('--disabled', 'Create the schedule disabled.')
    .action(async (objectiveParts: string[], options: ScheduleAddOptions) => {
      await withRuntime(program, printer, async runtime => {
        const objective = objectiveParts.join(' ');
        const created = await runtime.createSchedule({
          name: options.name ?? objective.slice(0, 60),
          objective,
          cron: options.cron,
          profile: options.profile,
          enabled: !options.disabled,
        });
        process.stdout.write(`Created schedule ${created.id} (${created.enabled ? 'enabled' : 'disabled'}).\n`);
        process.stdout.write('Schedules fire while marifold service is running.\n');
      });
    });

  schedule
    .command('list')
    .description('List schedules.')
    .action(async () => {
      await withRuntime(program, printer, async runtime => {
        const schedules = await runtime.listSchedules();
        if (schedules.length === 0) {
          process.stdout.write('No schedules. Create one with marifold schedule add.\n');
          return;
        }
        process.stdout.write('ID\tEnabled\tCron\tName\tLast run\n');
        for (const item of schedules) {
          process.stdout.write(`${item.id}\t${item.enabled ? 'yes' : 'no'}\t${item.cron}\t${item.name}\t${item.lastRunAt ?? '-'}\n`);
        }
      });
    });

  schedule
    .command('show')
    .description('Show one schedule.')
    .argument('<id>', 'Schedule id.')
    .action(async (id: string) => {
      await withRuntime(program, printer, async runtime => {
        const item = await runtime.getSchedule(id);
        if (!item) {
          process.stderr.write(`Schedule not found: ${id}\n`);
          process.exitCode = 1;
          return;
        }
        printSchedule(item);
      });
    });

  schedule
    .command('rm')
    .description('Delete a schedule.')
    .argument('<id>', 'Schedule id.')
    .action(async (id: string) => {
      await withRuntime(program, printer, async runtime => {
        if (await runtime.deleteSchedule(id)) {
          process.stdout.write(`Deleted schedule ${id}.\n`);
        } else {
          process.stderr.write(`Schedule not found: ${id}\n`);
          process.exitCode = 1;
        }
      });
    });

  schedule
    .command('enable')
    .description('Enable a schedule.')
    .argument('<id>', 'Schedule id.')
    .action(async (id: string) => {
      await withRuntime(program, printer, async runtime => {
        await runtime.updateSchedule(id, { enabled: true });
        process.stdout.write(`Enabled schedule ${id}.\n`);
      });
    });

  schedule
    .command('disable')
    .description('Disable a schedule.')
    .argument('<id>', 'Schedule id.')
    .action(async (id: string) => {
      await withRuntime(program, printer, async runtime => {
        await runtime.updateSchedule(id, { enabled: false });
        process.stdout.write(`Disabled schedule ${id}.\n`);
      });
    });

  schedule
    .command('run')
    .description('Run a schedule once now, unattended (ask-mode tools are denied).')
    .argument('<id>', 'Schedule id.')
    .action(async (id: string) => {
      await withRuntime(program, printer, async runtime => {
        const style = new TerminalStyle(process.stdout.isTTY ?? false);
        process.stdout.write(style.dim(`Running schedule ${id} unattended...\n`));
        const result = await runtime.runScheduleUnattended(id);
        process.stdout.write(`Run finished: ${result.status}${result.taskId ? ` (task ${result.taskId})` : ''}\n`);
        if (result.status !== 'completed') process.exitCode = 1;
      });
    });
}

type ScheduleMethods = 'createSchedule' | 'listSchedules' | 'getSchedule' | 'updateSchedule' | 'deleteSchedule' | 'runScheduleUnattended';
type ScheduleRuntime = { [K in ScheduleMethods]: (...args: Parameters<MarifoldRuntime[K]>) => ReturnType<MarifoldRuntime[K]> | Promise<Awaited<ReturnType<MarifoldRuntime[K]>>> };

async function withRuntime(
  program: Command,
  printer: ConsolePrinter,
  action: (runtime: ScheduleRuntime) => Promise<void>,
): Promise<void> {
  let local: MarifoldRuntime | undefined;
  try {
    const selected = program.commands.find(command => command.name() === 'schedule')?.opts().workspace as string | undefined;
    const api = await workspaceClient(program, selected);
    const runtime: ScheduleRuntime = api ? {
      createSchedule: async input => (await api.request<{ schedule: ScheduleState }>('POST', '/v1/schedules', input)).schedule,
      listSchedules: async () => (await api.request<{ schedules: ScheduleState[] }>('GET', '/v1/schedules')).schedules,
      getSchedule: async id => (await api.request<{ schedule: ScheduleState }>('GET', `/v1/schedules/${encodeURIComponent(id)}`)).schedule,
      updateSchedule: async (id, input) => (await api.request<{ schedule: ScheduleState }>('PATCH', `/v1/schedules/${encodeURIComponent(id)}`, input)).schedule,
      deleteSchedule: async id => (await api.request<{ deleted: boolean }>('DELETE', `/v1/schedules/${encodeURIComponent(id)}`)).deleted,
      runScheduleUnattended: id => api.request('POST', `/v1/schedules/${encodeURIComponent(id)}/run`, {}),
    } : local = createRuntime(program);
    await action(runtime);
  } catch (error) {
    printer.printError(error);
    process.exitCode = 1;
  } finally {
    local?.close();
  }
}

function printSchedule(item: ScheduleState): void {
  process.stdout.write(`ID:         ${item.id}\n`);
  process.stdout.write(`Name:       ${item.name}\n`);
  process.stdout.write(`Objective:  ${item.objective}\n`);
  process.stdout.write(`Cron:       ${item.cron}\n`);
  process.stdout.write(`Enabled:    ${item.enabled ? 'yes' : 'no'}\n`);
  if (item.profile) process.stdout.write(`Profile:    ${item.profile}\n`);
  process.stdout.write(`Last run:   ${item.lastRunAt ?? '-'}\n`);
  if (item.lastTaskId) process.stdout.write(`Last task:  ${item.lastTaskId}\n`);
  if (item.lastResultSeen !== undefined) process.stdout.write(`Result seen: ${item.lastResultSeen ? 'yes' : 'no'}\n`);
  process.stdout.write(`Created:    ${item.createdAt}\n`);
}
