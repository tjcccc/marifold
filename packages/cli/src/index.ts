#!/usr/bin/env node
import { Command } from 'commander';
import { registerAgentCommand } from './commands/agent';
import { registerAskCommand } from './commands/ask';
import { registerChatCommand } from './commands/chat';
import { registerChannelCommand } from './commands/channel';
import { registerConfigCommand } from './commands/config';
import { registerDoctorCommand } from './commands/doctor';
import { registerInitCommand } from './commands/init';
import { registerModelCommand } from './commands/model';
import { registerProfileCommand } from './commands/profile';
import { registerProviderCommand } from './commands/provider';
import { registerScheduleCommand } from './commands/schedule';
import { registerServiceCommand } from './commands/service';
import { registerSessionCommand } from './commands/session';
import { ConsolePrinter } from './output/ConsolePrinter';
import { loadConfig } from './commands/RuntimeFactory';

const printer = new ConsolePrinter();

const program = new Command()
  .name('marifold')
  .description('Marifold local-first AI workspace CLI.')
  .version('0.44.1')
  // Allow a root --profile (for the bare-`marifold` TUI launch) to coexist with
  // subcommand options of the same name: root options must precede the
  // subcommand, and options after the subcommand bind to it.
  .enablePositionalOptions()
  .option('--config <path>', 'Path to Marifold config.toml.')
  .option('--profile <name>', 'Profile to launch the TUI with.')
  .option(
    '--resume [id]',
    'Resume a session: bare --resume continues the most recent session for the profile; --resume <id> continues that specific session.',
  );

registerInitCommand(program, printer);
registerAgentCommand(program, printer);
registerAskCommand(program, printer);
registerChatCommand(program, printer);
registerChannelCommand(program, printer);
registerConfigCommand(program, printer);
registerDoctorCommand(program, printer);
registerModelCommand(program, printer);
registerProfileCommand(program, printer);
registerProviderCommand(program, printer);
registerScheduleCommand(program, printer);
registerServiceCommand(program, printer);
registerSessionCommand(program, printer);

// Bare `marifold` (or `marifold --profile x`) launches the Ink TUI. The TUI is
// an ESM-only package (Ink v7); the CLI is CommonJS, so import it through a
// real dynamic import the TypeScript CommonJS emit will not downlevel into a
// require() (which would throw ERR_REQUIRE_ESM on Node 18).
const importEsm = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<typeof import('@marifold/tui')>;

program.action(async () => {
  // Only a bare `marifold` (optionally with root options) launches the TUI. A
  // stray/unknown subcommand (e.g. `marifold frobnicate`) lands here too because
  // this is the default action — reject it instead of silently opening the TUI.
  if (program.args.length > 0) {
    printer.printError(new Error(`unknown command '${program.args[0]}'. Run \`marifold --help\` to see available commands.`));
    process.exitCode = 1;
    return;
  }
  const options = program.opts<{ profile?: string; resume?: string | boolean }>();
  const loadedConfig = loadConfig(program);
  const { runTui } = await importEsm('@marifold/tui');
  await runTui({
    loadedConfig,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
  });
});

program.parseAsync(process.argv).catch(error => {
  printer.printError(error);
  process.exitCode = 1;
});
