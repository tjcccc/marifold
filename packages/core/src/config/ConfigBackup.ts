import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoadedMarifoldConfig } from './ConfigSchema';
import { ConfigLoader } from './ConfigLoader';
import { renderMarifoldConfig } from './ConfigManager';
import { MarifoldError } from '../errors/MarifoldError';
import { resolveUserPath } from '../workspace/WorkspacePaths';

const BACKUP_SCHEMA = 'marifold.config-backup.v1';

interface BackupProfileFile {
  path: string;
  encoding: 'base64';
  content: string;
}

interface MarifoldConfigBackup {
  schema: typeof BACKUP_SCHEMA;
  exportedAt: string;
  configToml: string;
  profiles: BackupProfileFile[];
  sessionsDb?: {
    encoding: 'base64';
    content: string;
  };
}

export interface ConfigBackupExportOptions {
  includeSessions?: boolean;
}

export interface ConfigBackupExportResult {
  path: string;
  profileFileCount: number;
  includedSessions: boolean;
}

export interface ConfigBackupImportOptions {
  force?: boolean;
}

export interface ConfigBackupImportResult {
  configPath: string;
  profileFileCount: number;
  restoredSessions: boolean;
}

export function exportConfigBackup(
  loadedConfig: LoadedMarifoldConfig,
  outputPath: string,
  options: ConfigBackupExportOptions = {},
): ConfigBackupExportResult {
  const resolvedOutputPath = resolveUserPath(outputPath);
  const profileFiles = collectProfileFiles(loadedConfig.config.paths.profilesDir);
  const sessionsDb = options.includeSessions && fs.existsSync(loadedConfig.config.paths.sessionsDb)
    ? {
      encoding: 'base64' as const,
      content: fs.readFileSync(loadedConfig.config.paths.sessionsDb).toString('base64'),
    }
    : undefined;

  const backup: MarifoldConfigBackup = {
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    configToml: fs.existsSync(loadedConfig.configPath)
      ? fs.readFileSync(loadedConfig.configPath, 'utf-8')
      : renderMarifoldConfig(loadedConfig.config),
    profiles: profileFiles,
    ...(sessionsDb ? { sessionsDb } : {}),
  };

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(backup, null, 2)}\n`);
  return {
    path: resolvedOutputPath,
    profileFileCount: profileFiles.length,
    includedSessions: Boolean(sessionsDb),
  };
}

export function importConfigBackup(
  loadedConfig: LoadedMarifoldConfig,
  inputPath: string,
  options: ConfigBackupImportOptions = {},
): ConfigBackupImportResult {
  const resolvedInputPath = resolveUserPath(inputPath);
  const backup = readBackup(resolvedInputPath);
  const restoredConfig = loadBackupConfig(backup.configToml);
  const profileTargets = backup.profiles.map(file => ({
    file,
    target: path.join(restoredConfig.config.paths.profilesDir, safeRelativePath(file.path)),
  }));
  const sessionsTarget = backup.sessionsDb ? restoredConfig.config.paths.sessionsDb : undefined;

  if (!options.force) {
    if (fs.existsSync(loadedConfig.configPath)) {
      throw MarifoldError.configInvalid(`Config file already exists at ${loadedConfig.configPath}. Re-run with --force to overwrite it.`);
    }
    for (const target of profileTargets) {
      if (fs.existsSync(target.target)) {
        throw MarifoldError.configInvalid(`Profile file already exists at ${target.target}. Re-run with --force to overwrite it.`);
      }
    }
    if (sessionsTarget && fs.existsSync(sessionsTarget)) {
      throw MarifoldError.configInvalid(`Sessions database already exists at ${sessionsTarget}. Re-run with --force to overwrite it.`);
    }
  }

  fs.mkdirSync(path.dirname(loadedConfig.configPath), { recursive: true });
  fs.writeFileSync(loadedConfig.configPath, backup.configToml);

  for (const target of profileTargets) {
    fs.mkdirSync(path.dirname(target.target), { recursive: true });
    fs.writeFileSync(target.target, Buffer.from(target.file.content, target.file.encoding));
  }

  if (backup.sessionsDb && sessionsTarget) {
    fs.mkdirSync(path.dirname(sessionsTarget), { recursive: true });
    fs.writeFileSync(sessionsTarget, Buffer.from(backup.sessionsDb.content, backup.sessionsDb.encoding));
  }

  return {
    configPath: loadedConfig.configPath,
    profileFileCount: profileTargets.length,
    restoredSessions: Boolean(backup.sessionsDb),
  };
}

function collectProfileFiles(profilesDir: string): BackupProfileFile[] {
  if (!fs.existsSync(profilesDir)) return [];

  const files: BackupProfileFile[] = [];
  const stack = [profilesDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(profilesDir, absolutePath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue;
      files.push({
        path: relativePath,
        encoding: 'base64',
        content: fs.readFileSync(absolutePath).toString('base64'),
      });
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readBackup(inputPath: string): MarifoldConfigBackup {
  try {
    const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as Partial<MarifoldConfigBackup>;
    if (parsed.schema !== BACKUP_SCHEMA) {
      throw new Error(`Expected schema '${BACKUP_SCHEMA}'.`);
    }
    if (typeof parsed.configToml !== 'string') {
      throw new Error('Expected configToml to be a string.');
    }
    if (!Array.isArray(parsed.profiles)) {
      throw new Error('Expected profiles to be an array.');
    }
    for (const file of parsed.profiles) {
      if (
        typeof file !== 'object'
        || file === null
        || typeof file.path !== 'string'
        || file.encoding !== 'base64'
        || typeof file.content !== 'string'
      ) {
        throw new Error('Profile files must include path, base64 encoding, and content.');
      }
      safeRelativePath(file.path);
    }
    if (parsed.sessionsDb && (parsed.sessionsDb.encoding !== 'base64' || typeof parsed.sessionsDb.content !== 'string')) {
      throw new Error('sessionsDb must use base64 encoding.');
    }
    return {
      schema: BACKUP_SCHEMA,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      configToml: parsed.configToml,
      profiles: parsed.profiles,
      ...(parsed.sessionsDb ? { sessionsDb: parsed.sessionsDb } : {}),
    };
  } catch (error) {
    throw MarifoldError.configInvalid(`Could not read config backup ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadBackupConfig(configToml: string): LoadedMarifoldConfig {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-config-backup-'));
  const tempConfig = path.join(tempDir, 'config.toml');
  try {
    fs.writeFileSync(tempConfig, configToml);
    return new ConfigLoader().load({ configPath: tempConfig });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function safeRelativePath(filePath: string): string {
  if (!filePath || path.isAbsolute(filePath)) {
    throw MarifoldError.configInvalid(`Invalid backup profile path: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw MarifoldError.configInvalid(`Invalid backup profile path: ${filePath}`);
  }
  return normalized;
}
