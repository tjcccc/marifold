import { Command } from 'commander';
import { ConfigManager, MarifoldError, ProfileManager } from '@marifold/core';
import type { MemoryEntry } from '@marifold/core';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { PromptAbortError, isPromptAbortError } from '../input/PromptAbort';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime } from './RuntimeFactory';
import { loadConfig } from './RuntimeFactory';

interface ProfileDeleteOptions {
  yes?: boolean;
}

interface ProfileMemoryOptions {
  all?: boolean;
  limit?: number;
}

export function registerProfileCommand(program: Command, printer: ConsolePrinter): void {
  const profile = program
    .command('profile')
    .description('Inspect and manage Marifold profiles.')
    .action(() => {
      try {
        const { config } = loadConfig(program);
        process.stdout.write(`Current profile: ${config.default.profile}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  profile
    .command('list')
    .description('List available profiles.')
    .action(() => {
      const runtime = createRuntime(program);
      try {
        printer.printProfiles(runtime.listProfiles());
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  profile
    .command('show')
    .description('Show profile files and model settings.')
    .argument('[name]', 'Profile name. Defaults to the configured default profile.')
    .action((name: string | undefined) => {
      const runtime = createRuntime(program);
      try {
        const loadedConfig = loadConfig(program);
        const profileName = name ?? loadedConfig.config.default.profile;
        const detail = runtime.getProfile(profileName);

        process.stdout.write(`Profile: ${detail.name}\n`);
        process.stdout.write(`Source:  ${detail.source}\n`);
        if (detail.path) process.stdout.write(`Path:    ${detail.path}\n`);
        process.stdout.write(`Model:   ${detail.settings.provider && detail.settings.model ? `${detail.settings.provider}/${detail.settings.model}` : 'default'}\n`);
        process.stdout.write(`Memory:  ${detail.settings.memories ? 'on' : 'off'}\n`);
        printProfileSection('INSTRUCTIONS.md', detail.files.instructions);
        if (detail.instructionFormat === 'legacy') {
          process.stdout.write(`Legacy:  ${detail.legacyInstructionFiles.join(', ')} (run marifold doctor --fix --profile ${detail.name})\n`);
        }
        printProfileSection('profile.toml', detail.files.profileToml);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  profile
    .command('memory')
    .description('List profile memory records.')
    .argument('[name]', 'Profile name. Defaults to the configured default profile.')
    .option('--all', 'Include superseded memory records.')
    .option('--limit <n>', 'Maximum records to print.', parsePositiveInteger)
    .action((name: string | undefined, options: ProfileMemoryOptions) => {
      const runtime = createRuntime(program);
      try {
        const loadedConfig = loadConfig(program);
        const profileName = name ?? loadedConfig.config.default.profile;
        runtime.ensureProfileMemoryFiles(profileName);
        const memories = runtime.listMemories(profileName, Boolean(options.all));
        printMemoryRecords(profileName, memories, options.limit ?? 50);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });

  profile
    .command('init')
    .description('Scaffold a new profile directory.')
    .argument('[name]', 'Profile name (letters, numbers, underscores, and hyphens only).')
    .action(async (name: string | undefined) => {
      const prompt = new InteractivePrompt();
      try {
        const loadedConfig = loadConfig(program);
        const profileName = name ?? (await prompt.readUserMessage('Profile name: '))?.trim();
        if (!profileName) throw MarifoldError.profileInvalid('Profile name cannot be empty.', '');

        const result = new ProfileManager(loadedConfig.config.paths.profilesDir).init(profileName);
        process.stdout.write(`Created profile '${result.name}' at ${result.path}\n`);
        for (const filePath of result.files) process.stdout.write(`created ${filePath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt.close();
      }
    });

  profile
    .command('rename')
    .description('Rename a stored profile.')
    .argument('<from>', 'Current profile name.')
    .argument('<to>', 'New profile name (letters, numbers, underscores, and hyphens only).')
    .action((from: string, to: string) => {
      try {
        const loadedConfig = loadConfig(program);
        const result = new ProfileManager(loadedConfig.config.paths.profilesDir).rename(from, to);
        if (loadedConfig.config.default.profile === from) {
          new ConfigManager(loadedConfig).setDefaultProfile(to);
          process.stdout.write(`Default profile updated to '${to}'.\n`);
        }
        process.stdout.write(`Renamed profile '${result.from}' to '${result.to}'.\n`);
        process.stdout.write(`Moved ${result.fromPath} to ${result.toPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });

  profile
    .command('delete')
    .alias('rm')
    .description('Delete a stored profile directory or JSON file.')
    .argument('<name>', 'Profile name.')
    .option('--yes', 'Delete without interactive confirmation.')
    .action(async (name: string, options: ProfileDeleteOptions) => {
      const prompt = new InteractivePrompt();
      try {
        const loadedConfig = loadConfig(program);
        if (loadedConfig.config.default.profile === name) {
          throw MarifoldError.profileInvalid(`Cannot delete the current default profile '${name}'. Set another default profile first.`, name);
        }
        if (!options.yes) {
          const answer = await prompt.readUserMessage(`Delete profile '${name}'? Type '${name}' to confirm: `);
          if (answer === undefined) throw new PromptAbortError();
          if (answer.trim() !== name) {
            process.stdout.write('Aborted.\n');
            process.exitCode = 1;
            return;
          }
        }

        const result = new ProfileManager(loadedConfig.config.paths.profilesDir).delete(name);
        process.stdout.write(`Deleted profile '${result.name}' from ${result.path}\n`);
      } catch (error) {
        if (isPromptAbortError(error)) {
          process.stderr.write('Aborted.\n');
          process.exitCode = 130;
          return;
        }
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        prompt.close();
      }
    });

  profile
    .command('default')
    .description('Show or set the default profile.')
    .argument('[name]', 'Profile name to set as default.')
    .action((name: string | undefined) => {
      try {
        const loadedConfig = loadConfig(program);
        if (!name) {
          process.stdout.write(`Current profile: ${loadedConfig.config.default.profile}\n`);
          return;
        }

        const profileManager = new ProfileManager(loadedConfig.config.paths.profilesDir);
        if (!profileManager.exists(name)) {
          throw MarifoldError.profileInvalid(`Profile '${name}' was not found.`, name);
        }
        const result = new ConfigManager(loadedConfig).setDefaultProfile(name);
        process.stdout.write(`Default profile set to '${name}'.\n`);
        process.stdout.write(`Saved ${result.configPath}\n`);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}

function printProfileSection(label: string, file: { path?: string; content: string }): void {
  process.stdout.write(`\n[${label}]`);
  if (file.path) process.stdout.write(` ${file.path}`);
  process.stdout.write('\n');
  process.stdout.write(file.content.trim() ? `${file.content.trimEnd()}\n` : '(empty)\n');
}

function printMemoryRecords(profile: string, memories: MemoryEntry[], limit: number): void {
  process.stdout.write(`Profile: ${profile}\n`);
  if (memories.length === 0) {
    process.stdout.write('No memory records found.\n');
    return;
  }

  for (const memory of memories.slice(0, limit)) {
    const conflict = memory.conflict_key ? ` conflict=${memory.conflict_key}` : '';
    process.stdout.write(
      `${memory.kind}\t${memory.status}\tpriority=${memory.priority}\tconfidence=${memory.confidence}${conflict}\n`,
    );
    process.stdout.write(`  id: ${memory.id}\n`);
    process.stdout.write(`  text: ${memory.text}\n`);
    process.stdout.write(`  source: ${memory.source} (${memory.source_type}) scope=${memory.scope}\n`);
    process.stdout.write(`  updated: ${memory.updated_at}\n`);
  }
  if (memories.length > limit) {
    process.stdout.write(`... ${memories.length - limit} more record(s). Use --limit to show more.\n`);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Expected a positive integer.');
  return parsed;
}
