import { Command } from 'commander';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { createRuntime, loadConfig } from './RuntimeFactory';

/**
 * `marifold doctor` — environment health check. Reports the active provider/model,
 * profile-instruction format, and a read-only integrity check of the session DB.
 * The session check is the reason this lives on the CLI rather than the TUI's
 * `/doctor`: when the session DB is corrupt the TUI cannot even start, so the
 * diagnostic must be reachable from a command that never opens the store eagerly.
 */
export function registerDoctorCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('doctor')
    .description('Check Marifold health: configuration, profile instructions, and session database integrity.')
    .option('--profile <name>', 'Limit profile checks and migration to this profile.')
    .option('--fix', 'Back up and migrate legacy profile instructions.')
    .action((options: { profile?: string; fix?: boolean }) => {
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

        // Profile instructions — detection is read-only unless --fix is explicit.
        out.write('\nProfile instructions\n');
        const targets = options.profile
          ? runtime.listProfiles().filter(profile => profile.name === options.profile)
          : runtime.listProfiles();
        const fixCommand = options.profile
          ? `marifold doctor --fix --profile ${options.profile}`
          : 'marifold doctor --fix';
        if (targets.length === 0 && options.profile) {
          out.write(`  ✗ Profile '${options.profile}' was not found.\n`);
          process.exitCode = 1;
        }
        for (const target of targets) {
          try {
            let detail = runtime.getProfile(target.name);
            const needsFix = detail.instructionFormat === 'legacy'
              || detail.legacyInstructionFiles.length > 0;
            if (options.fix && needsFix) {
              const result = runtime.migrateProfileInstructions(target.name);
              detail = runtime.getProfile(target.name);
              const action = result.status === 'migrated' ? 'migrated' : 'cleaned';
              out.write(`  ${target.name}: ✓ ${action} to INSTRUCTIONS.md\n`);
              if (result.backupPath) out.write(`    Backup: ${result.backupPath}\n`);
              continue;
            }

            if (detail.instructionFormat === 'unified' && detail.legacyInstructionFiles.length === 0) {
              out.write(`  ${target.name}: ✓ INSTRUCTIONS.md\n`);
            } else if (detail.instructionFormat === 'legacy') {
              out.write(`  ${target.name}: ⚠ legacy ${detail.legacyInstructionFiles.join(', ')}\n`);
              out.write(`    Run \`${fixCommand}\` to back up and migrate it.\n`);
            } else if (detail.instructionFormat === 'unified') {
              out.write(`  ${target.name}: ⚠ INSTRUCTIONS.md with legacy files pending cleanup\n`);
              out.write(`    Run \`${fixCommand}\` to back up and archive them.\n`);
            } else if (detail.instructionFormat === 'built-in') {
              out.write(`  ${target.name}: ✓ built-in instructions\n`);
            } else if (detail.instructionFormat === 'json') {
              out.write(`  ${target.name}: ⚠ legacy JSON profile (supported; not changed by --fix)\n`);
            } else {
              out.write(`  ${target.name}: ⚠ no instruction document\n`);
            }
          } catch (error) {
            out.write(`  ${target.name}: ✗ ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
          }
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

        // Channels — only when a [channel.*] section is configured.
        const tg = loadConfig(program).config.channels?.telegram;
        if (tg) {
          out.write('\nChannel (telegram)\n');
          const tokenOk = tg.botTokenEnv ? Boolean(process.env[tg.botTokenEnv]) : Boolean(tg.botToken);
          const tokenDesc = tg.botTokenEnv ? `${tg.botTokenEnv} ${process.env[tg.botTokenEnv] ? '✓ set' : '✗ unset'}` : (tg.botToken ? 'in config' : '✗ missing');
          const profileOk = runtime.listProfiles().some(p => p.name === tg.profile);
          out.write(`  Bot token:    ${tokenDesc}\n`);
          out.write(`  Allowlist:    ${tg.allowlist.length} user(s)${tg.allowlist.length === 0 ? ' ✗ (bot is locked)' : ''}\n`);
          out.write(`  Profile:      ${tg.profile}${profileOk ? '' : ' ✗ (not found)'}\n`);
          out.write(`  Default mode: ${tg.defaultMode}\n`);
          if (!tokenOk || tg.allowlist.length === 0 || !profileOk) {
            out.write('  Status: ✗ not ready — fix the ✗ items (or rerun `marifold channel telegram setup`).\n');
            process.exitCode = 1;
          } else {
            out.write('  Status: ✓ ready\n');
          }
        }
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        runtime.close();
      }
    });
}
