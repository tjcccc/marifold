import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceInitializer } from '@marifold/core';
import { registerDoctorCommand } from '../src/commands/doctor';
import { ConsolePrinter } from '../src/output/ConsolePrinter';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('doctor profile migration', () => {
  it('reports legacy files read-only and migrates them only with --fix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-doctor-'));
    tempDirs.push(root);
    const configPath = path.join(root, 'config.toml');
    const profilesDir = path.join(root, 'profiles');
    new WorkspaceInitializer().initialize({
      configPath,
      profilesDir,
      sessionsDb: path.join(root, 'sessions.db'),
      tasksDir: path.join(root, 'tasks'),
    });
    const profileDir = path.join(profilesDir, 'default');
    fs.rmSync(path.join(profileDir, 'INSTRUCTIONS.md'));
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Custom');

    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await doctorProgram().parseAsync(['node', 'marifold', '--config', configPath, 'doctor']);
    expect(output.join('')).toContain('default: ⚠ legacy PROFILE.md, RULES.md, CUSTOM.md');
    expect(fs.existsSync(path.join(profileDir, 'INSTRUCTIONS.md'))).toBe(false);

    output.length = 0;
    await doctorProgram().parseAsync([
      'node', 'marifold', '--config', configPath, 'doctor', '--fix', '--profile', 'default',
    ]);
    expect(output.join('')).toContain('default: ✓ migrated to INSTRUCTIONS.md');
    expect(fs.readFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), 'utf-8')).toBe('Rules\n\nIdentity\n\nCustom');
    expect(fs.existsSync(path.join(profileDir, 'PROFILE.md'))).toBe(false);
    expect(fs.existsSync(path.join(profilesDir, '.legacy-instructions'))).toBe(true);
  });
});

function doctorProgram(): Command {
  const program = new Command()
    .name('marifold')
    .option('--config <path>');
  registerDoctorCommand(program, new ConsolePrinter());
  return program;
}
