#!/usr/bin/env node
import { Command } from 'commander';
import { registerAskCommand } from './commands/ask';
import { registerChatCommand } from './commands/chat';
import { registerProfileCommand } from './commands/profile';
import { registerSessionCommand } from './commands/session';
import { ConsolePrinter } from './output/ConsolePrinter';

const printer = new ConsolePrinter();

const program = new Command()
  .name('marifold')
  .description('Marifold local-first AI workspace CLI.')
  .version('0.0.1')
  .option('--config <path>', 'Path to Marifold config.toml.');

registerAskCommand(program, printer);
registerChatCommand(program, printer);
registerProfileCommand(program, printer);
registerSessionCommand(program, printer);

program.parseAsync(process.argv).catch(error => {
  printer.printError(error);
  process.exitCode = 1;
});
