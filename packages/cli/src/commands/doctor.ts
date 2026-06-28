import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime, loadConfig } from './RuntimeFactory';

/**
 * `marifold doctor` — environment health check. Reports the active provider/model
 * config and, importantly, runs a read-only integrity check of the session DB.
 * The session check is the reason this lives on the CLI rather than the TUI's
 * `/doctor`: when the session DB is corrupt the TUI cannot even start, so the
 * diagnostic must be reachable from a command that never opens the store eagerly.
 */
export function registerDoctorCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('doctor')
    .description('Check Marifold health: provider/model config and session database integrity.')
    .option('--profile <name>', 'Check this profile (defaults to the active profile).')
    .action((options: { profile?: string }) => {
      const runtime = createRuntime(program);
      const out = process.stdout;
      try {
        out.write('Marifold doctor\n\n');

        // Provider & model — resolved independently so a config gap here never
        // blocks the session-DB check below.
        out.write('Provider & model\n');
        try {
          const loaded = loadConfig(program);
          const settings = runtime.resolveSettings(options.profile ? { profile: options.profile } : {});
          const provider = loaded.config.providers[settings.provider];
          const keyEnv = provider?.apiKeyEnv;
          out.write(`  Profile:     ${settings.profile}\n`);
          out.write(`  Provider:    ${settings.provider}\n`);
          out.write(`  Model:       ${settings.model}\n`);
          out.write(`  Type:        ${provider?.type ?? 'unknown'}\n`);
          out.write(`  Base URL:    ${provider?.baseUrl ?? '(default)'}\n`);
          out.write(`  API key env: ${keyEnv ? `${keyEnv} ${process.env[keyEnv] ? '✓ set' : '✗ unset'}` : '(none)'}\n`);
          out.write(`  Stored key:  ${provider?.apiKey ? 'present' : 'none'}\n`);
        } catch (error) {
          out.write(`  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        }

        // Session database — read-only integrity check; safe even when corrupt.
        out.write('\nSession database\n');
        out.write(`  Path: ${runtime.sessionDbPath}\n`);
        const health = runtime.checkSessionDb();
        if (!health.exists) {
          out.write('  Status: none yet (no sessions saved)\n');
        } else if (health.ok) {
          out.write(`  Status: ✓ ok (${health.sessions} sessions, ${health.turns} turns)\n`);
        } else {
          out.write(`  Status: ✗ CORRUPT — ${health.error}\n`);
          out.write('  The session DB is damaged. A guided repair (backs up first) is coming in `marifold session repair`.\n');
          process.exitCode = 1;
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });
}
