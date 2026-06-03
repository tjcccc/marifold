#!/usr/bin/env node
import { Command } from 'commander';
import { registerAskCommand } from './commands/ask';
import { registerChatCommand } from './commands/chat';
import { registerConfigCommand } from './commands/config';
import { registerInitCommand } from './commands/init';
import { registerModelCommand } from './commands/model';
import { registerProfileCommand } from './commands/profile';
import { registerProviderCommand } from './commands/provider';
import { registerSessionCommand } from './commands/session';
import { ConsolePrinter } from './output/ConsolePrinter';

const printer = new ConsolePrinter();

const program = new Command()
  .name('marifold')
  .description('Marifold local-first AI workspace CLI.')
  .version('0.3.0')
  .option('--config <path>', 'Path to Marifold config.toml.');

registerInitCommand(program, printer);
registerAskCommand(program, printer);
registerChatCommand(program, printer);
registerConfigCommand(program, printer);
registerModelCommand(program, printer);
registerProfileCommand(program, printer);
registerProviderCommand(program, printer);
registerSessionCommand(program, printer);

program.parseAsync(process.argv).catch(error => {
  printer.printError(error);
  process.exitCode = 1;
});
