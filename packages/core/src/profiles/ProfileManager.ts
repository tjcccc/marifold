import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { parse } from 'smol-toml';
import { MarifoldError } from '../errors/MarifoldError';
import { ensureProfileMemoryFiles } from '../memory/MemoryStore';
import { expandHome } from '../workspace/WorkspacePaths';
import type { ProfileMode } from '../config/ConfigSchema';
import type { ApprovalMode, ToolKind } from '../agent/ApprovalPolicy';
import { SENSITIVE_HOME_ENTRIES } from '../agent/RunWorkspace';
import {
  PROFILE_INSTRUCTIONS_FILE,
  resolveDirectoryProfileInstructions,
} from './ProfileInstructions';
import { assertNewProfileName } from './ProfileName';
import { PROFILE_DEFAULT_MODEL, parseProfileModel, profileModelValue } from './ProfileModel';

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

/** Accepted avatar media types → the stored file extension. */
const AVATAR_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
/** Media assets (avatars, and future banners/exports) live under this subdir
 * so binaries don't clutter the profile root next to INSTRUCTIONS.md. */
const ASSETS_DIR = 'assets';
// The web client crops to 512² and compresses as WebP. Keep the existing limit
// for API clients, older avatars and browsers that fall back to PNG.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const PROFILE_INSTRUCTIONS_STUB = `# {name}

You are a helpful assistant.

## Guidelines

- Be honest. Do not make things up.
- Be concise unless the user asks for depth.
`;

/** Documented per-profile config template. Shared by `profile create` and the
 * default profile scaffolded at `marifold init`, so both list every option. */
export const PROFILE_TOML_STUB = `# profile.toml — per-profile overrides. Every key is optional; uncomment to set.
# Anything left commented falls back to the global [default] in config.toml.

# Human-readable name shown by clients. Blank or absent = profile name.
# display_name = "Writing Assistant"

# Model: "provider/model" pins one (for example "ollama/gemma4:e4b");
# "default" follows the global default model in config.toml.
model = "default"

# Load this profile's structured memory into context (default true).
# memories = true

# Conversation-context budget in tokens; enables compaction past ~80%.
# Falls back to default.max_context_tokens.
# max_context_tokens = 16000

# Hard cap on recent session turns replayed each request: "all" = no cap,
# N = last N, 0 = none. Falls back to default.session_context_turns.
# session_context_turns = "all"

# Per-profile agent tool permissions — override the global [agent.approval].
# Kinds: read | write | shell | network | delegate. Modes: "allow" | "ask" | "deny".
# Unset kinds inherit the global default; "ask" with no interactive handler
# (e.g. an unattended/messaging context) safely degrades to deny.
# agent.approval.shell = "allow"
# agent.approval.write = "ask"

# File tools already create, edit, move, and trash files inside your home
# without asking (unless write = "deny"). Trusted folders additionally open a
# folder to sandboxed shell commands. e.g. a profile that writes a daily blog:
# agent.trusted_folders = ["~/my_docs/blog"]

# Sensitive folders this profile may read without asking, added by an
# "Always allow" answer, e.g.:
# agent.sensitive_read_grants = ["~/.ssh"]
`;

export interface ProfileInitResult {
  name: string;
  path: string;
  files: string[];
}

/** The canonical editable instruction document plus deprecated service aliases. */
export type ProfileFileKind = 'instructions' | 'profile' | 'rules' | 'custom';

const PROFILE_FILE_NAMES: Record<ProfileFileKind, string> = {
  instructions: PROFILE_INSTRUCTIONS_FILE,
  profile: 'PROFILE.md',
  rules: 'RULES.md',
  custom: 'CUSTOM.md',
};

export interface ProfileInstructionsMigrationResult {
  name: string;
  status: 'migrated' | 'cleaned' | 'unchanged' | 'not-applicable';
  instructionsPath?: string;
  backupPath?: string;
  legacyFiles: string[];
}

export interface ProfileModelOverrideResult {
  name: string;
  path: string;
  provider?: string;
  model?: string;
  cleared: boolean;
}

export interface ProfileSettingsMigrationResult {
  name: string;
  status: 'migrated' | 'unchanged';
  /** The `model` value written, when the model line was rewritten. */
  value?: string;
  /** The retired per-profile `think` value that was removed. */
  removedThink?: boolean;
  backupPath?: string;
}

export interface ProfileModeResult {
  name: string;
  path: string;
  mode: ProfileMode;
}

export interface ProfileRenameResult {
  from: string;
  to: string;
  fromPath: string;
  toPath: string;
}

export interface ProfileDeleteResult {
  name: string;
  path: string;
}

export class ProfileManager {
  constructor(private readonly profilesDir: string) {}

  init(name: string): ProfileInitResult {
    assertNewProfileName(name);
    const profileDir = path.join(this.profilesDir, name);
    if (fs.existsSync(profileDir)) {
      throw MarifoldError.profileInvalid(`Profile '${name}' already exists at ${profileDir}.`, name);
    }

    fs.mkdirSync(profileDir, { recursive: true });
    const files = [
      writeFile(path.join(profileDir, PROFILE_INSTRUCTIONS_FILE), PROFILE_INSTRUCTIONS_STUB.replace('{name}', name)),
      writeFile(path.join(profileDir, 'profile.toml'), PROFILE_TOML_STUB),
      ...ensureProfileMemoryFiles(profileDir).map(file => file.path),
    ];

    return { name, path: profileDir, files };
  }

  /** Persist a human-readable profile label. Blank/undefined clears the
   * override so clients fall back to the stable profile name. */
  setDisplayName(name: string, displayName: string | undefined): { name: string; path: string; displayName?: string } {
    const normalized = normalizeProfileDisplayName(displayName, name);
    return this.upsertSetting(
      name,
      'display_name',
      normalized === undefined ? undefined : tomlString(normalized),
      normalized === undefined ? {} : { displayName: normalized },
    );
  }

  setModelOverride(name: string, provider: string, model: string): ProfileModelOverrideResult {
    assertSafeName(name);
    if (!provider || !model) {
      throw MarifoldError.profileInvalid('Profile model overrides require both provider and model.', name);
    }
    if (provider.includes('/')) {
      throw MarifoldError.profileInvalid(`Provider name '${provider}' cannot contain "/".`, name);
    }
    const profileToml = path.join(this.requireProfileDir(name), 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertModelLine(current, profileModelValue(provider, model)));
    return { name, path: profileToml, provider, model, cleared: false };
  }

  /** Follow the global default model again: writes `model = "default"`. */
  clearModelOverride(name: string): ProfileModelOverrideResult {
    assertSafeName(name);
    const profileToml = path.join(this.requireProfileDir(name), 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertModelLine(current, PROFILE_DEFAULT_MODEL));
    return { name, path: profileToml, cleared: true };
  }

  /** Bring profile.toml to the current form after one backup. An older
   * `provider` + `model` pair, or a missing model line, becomes one `model`
   * line (a pin stays a pin, no pin becomes `model = "default"`), and the
   * retired per-profile `think` key is removed because Deep (`default.deep`) is global. */
  migrateProfileSettings(name: string): ProfileSettingsMigrationResult {
    assertSafeName(name);
    const profileToml = path.join(this.requireProfileDir(name), 'profile.toml');
    if (!fs.existsSync(profileToml)) { return { name, status: 'unchanged' }; }
    const original = fs.readFileSync(profileToml, 'utf-8');
    const raw = parse(original) as { provider?: unknown; model?: unknown; think?: unknown };
    const current = parseProfileModel(
      name,
      typeof raw.provider === 'string' ? raw.provider : undefined,
      typeof raw.model === 'string' ? raw.model : undefined,
    );
    const rewriteModel = current.setting === 'legacy' || current.setting === 'unset';
    const removedThink = typeof raw.think === 'boolean' ? raw.think : undefined;
    if (!rewriteModel && removedThink === undefined) { return { name, status: 'unchanged' }; }
    const backupPath = path.join(createInstructionsBackupDir(this.profilesDir, name, '.legacy-profile-toml'), 'profile.toml');
    fs.copyFileSync(profileToml, backupPath);
    let text = removedThink === undefined ? original : removeTopLevelKey(original, 'think');
    const value = rewriteModel ? profileModelValue(current.provider, current.model) : undefined;
    if (value !== undefined) { text = upsertModelLine(text, value); }
    atomicWriteFile(profileToml, text);
    return {
      name, status: 'migrated', backupPath,
      ...(value !== undefined ? { value } : {}),
      ...(removedThink !== undefined ? { removedThink } : {}),
    };
  }

  /** Retained compatibility API for older clients that persist profile mode. */
  setMode(name: string, mode: ProfileMode): ProfileModeResult {
    assertSafeName(name);
    const profileDir = this.requireProfileDir(name);
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertMode(current, mode));
    return { name, path: profileToml, mode };
  }

  /** Persist (or clear, when tokens is undefined/0) the profile's context budget. */
  setMaxContextTokens(name: string, tokens: number | undefined): { name: string; path: string; maxContextTokens?: number } {
    assertSafeName(name);
    const profileDir = this.requireProfileDir(name);
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertMaxContextTokens(current, tokens));
    return { name, path: profileToml, maxContextTokens: tokens && tokens > 0 ? tokens : undefined };
  }

  /** Persist a per-profile approval decision into profile.toml as a dotted key
   * (e.g. `agent.approval.shell = "allow"`), overriding the global `[agent]`.
   * `mode: undefined` removes the override so the kind inherits again. */
  setAgentApproval(name: string, kind: ToolKind, mode: ApprovalMode | undefined): { name: string; path: string; kind: ToolKind; mode?: ApprovalMode } {
    assertSafeName(name);
    // Create the profile dir if absent — the built-in `default` profile is served
    // without one, and "always allow" must still persist there (mirrors setModelOverride).
    const profileDir = path.join(this.profilesDir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertFlatLine(current, `agent.approval.${kind}`, mode === undefined ? undefined : tomlString(mode)));
    return { name, path: profileToml, kind, ...(mode !== undefined ? { mode } : {}) };
  }

  /** Overwrite the canonical instructions or a deprecated split-file alias. */
  writeProfileFile(name: string, file: ProfileFileKind, content: string): { name: string; path: string; file: ProfileFileKind } {
    assertSafeName(name);
    let fileName = PROFILE_FILE_NAMES[file];
    if (!fileName) {
      throw MarifoldError.profileInvalid(`Unknown profile file '${String(file)}'. Use instructions.`, name);
    }
    const profileDir = path.join(this.profilesDir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const hasUnifiedInstructions = fs.existsSync(path.join(profileDir, PROFILE_INSTRUCTIONS_FILE));
    if (file === 'profile' && hasUnifiedInstructions) {
      fileName = PROFILE_INSTRUCTIONS_FILE;
    } else if ((file === 'rules' || file === 'custom') && hasUnifiedInstructions) {
      throw MarifoldError.profileInvalid(
        `Profile '${name}' uses ${PROFILE_INSTRUCTIONS_FILE}; edit its instructions instead of ${fileName}.`,
        name,
      );
    }
    const filePath = path.join(profileDir, fileName);
    fs.writeFileSync(filePath, content);
    return { name, path: filePath, file };
  }

  /** Consolidate legacy split documents and remove them from the active profile
   * only after copying them to a timestamped backup. Safe to call repeatedly. */
  migrateProfileInstructions(name: string): ProfileInstructionsMigrationResult {
    assertSafeName(name);
    const stored = this.requireStoredProfile(name);
    if (stored.type !== 'directory') {
      return { name, status: 'not-applicable', legacyFiles: [] };
    }

    const resolved = resolveDirectoryProfileInstructions(stored.path);
    if (resolved.legacyFiles.length === 0) {
      return {
        name,
        status: resolved.format === 'unified' ? 'unchanged' : 'not-applicable',
        ...(resolved.format === 'unified' ? { instructionsPath: resolved.path } : {}),
        legacyFiles: [],
      };
    }

    const backupPath = createInstructionsBackupDir(this.profilesDir, name);
    for (const fileName of resolved.legacyFiles) {
      fs.copyFileSync(path.join(stored.path, fileName), path.join(backupPath, fileName));
    }

    if (resolved.format === 'legacy') {
      atomicWriteFile(resolved.path, resolved.content);
      if (fs.readFileSync(resolved.path, 'utf-8') !== resolved.content) {
        throw MarifoldError.profileInvalid(`Could not verify migrated instructions for profile '${name}'.`, name);
      }
    }

    for (const fileName of resolved.legacyFiles) {
      fs.rmSync(path.join(stored.path, fileName), { force: true });
    }

    return {
      name,
      status: resolved.format === 'legacy' ? 'migrated' : 'cleaned',
      instructionsPath: resolved.path,
      backupPath,
      legacyFiles: resolved.legacyFiles,
    };
  }

  /** Persist (or clear, when undefined) whether this profile loads its memory. */
  setMemories(name: string, memories: boolean | undefined): { name: string; path: string; memories?: boolean } {
    return this.upsertSetting(name, 'memories', memories === undefined ? undefined : String(memories), { memories });
  }

  /** Persist the profile's recent-turn window. `undefined` or `'all'` removes the
   * key (inherit `default.session_context_turns`); an integer ≥ 0 caps replay. */
  setSessionContextTurns(name: string, turns: number | 'all' | undefined): { name: string; path: string; sessionContextTurns?: number } {
    if (typeof turns === 'number' && (!Number.isInteger(turns) || turns < 0)) {
      throw MarifoldError.profileInvalid('session_context_turns must be a non-negative integer or "all".', name);
    }
    const cleared = turns === undefined || turns === 'all';
    return this.upsertSetting(
      name,
      'session_context_turns',
      cleared ? undefined : String(turns),
      cleared ? {} : { sessionContextTurns: turns as number },
    );
  }

  private upsertSetting<T extends object>(name: string, key: string, rendered: string | undefined, result: T): { name: string; path: string } & T {
    assertSafeName(name);
    const profileDir = path.join(this.profilesDir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertFlatLine(current, key, rendered));
    return { name, path: profileToml, ...result };
  }

  /** Add a trusted folder capability to profile.toml. In-home writes may be
   * silent; external folders still prompt. Refuses broad/sensitive roots. */
  addTrustedFolder(name: string, folder: string): { name: string; path: string; folder: string } {
    assertSafeName(name);
    const resolved = path.resolve(expandHome(folder));
    assertSafeTrustedFolder(resolved);
    const profileDir = path.join(this.profilesDir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    fs.writeFileSync(profileToml, upsertTrustedFolder(current, resolved));
    return { name, path: profileToml, folder: resolved };
  }

  /** Add or remove a home-relative sensitive read root (`~/.ssh`) in the
   * profile's `agent.sensitive_read_grants`. Only known sensitive roots qualify. */
  setSensitiveReadGrant(name: string, grant: string, allowed: boolean): { name: string; path: string; grant: string } {
    assertSafeName(name);
    const entry = grant.trim().replace(/^~\//, '').replace(/\/+$/, '');
    if (!SENSITIVE_HOME_ENTRIES.includes(entry) || entry === '.marifold') {
      throw MarifoldError.profileInvalid(`'${grant}' is not a sensitive folder Marifold recognizes.`, name);
    }
    const normalized = `~/${entry}`;
    const profileDir = path.join(this.profilesDir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    const grants = parseAgentStringList(current, 'sensitive_read_grants').filter(value => value !== normalized);
    if (allowed) { grants.push(normalized); }
    fs.writeFileSync(profileToml, upsertFlatLine(current, 'agent.sensitive_read_grants', grants.length > 0 ? `[${grants.map(tomlString).join(', ')}]` : undefined));
    return { name, path: profileToml, grant: normalized };
  }

  /** Remove a trusted folder from the profile's profile.toml. Compares against
   * the resolved absolute path (same normalization addTrustedFolder applies). */
  removeTrustedFolder(name: string, folder: string): { name: string; path: string; folder: string; removed: boolean } {
    assertSafeName(name);
    const resolved = path.resolve(expandHome(folder));
    const profileDir = this.requireProfileDir(name);
    const profileToml = path.join(profileDir, 'profile.toml');
    const current = fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : PROFILE_TOML_STUB;
    const folders = parseTrustedFolders(current);
    const next = folders.filter(entry => entry !== resolved);
    fs.writeFileSync(profileToml, renderTrustedFolders(current, next));
    return { name, path: profileToml, folder: resolved, removed: next.length !== folders.length };
  }

  rename(from: string, to: string): ProfileRenameResult {
    assertSafeName(from);
    assertNewProfileName(to);
    if (from === to) { throw MarifoldError.profileInvalid('New profile name must be different from the current name.', from); }
    if (from === 'default' || to === 'default') {
      throw MarifoldError.profileInvalid('Profile rename does not support the built-in default profile.', from);
    }

    const existing = this.requireStoredProfile(from);
    const targetPath = existing.type === 'directory'
      ? path.join(this.profilesDir, to)
      : path.join(this.profilesDir, `${to}.json`);
    if (fs.existsSync(path.join(this.profilesDir, to)) || fs.existsSync(path.join(this.profilesDir, `${to}.json`))) {
      throw MarifoldError.profileInvalid(`Profile '${to}' already exists in ${this.profilesDir}.`, to);
    }

    fs.renameSync(existing.path, targetPath);
    return { from, to, fromPath: existing.path, toPath: targetPath };
  }

  delete(name: string): ProfileDeleteResult {
    assertSafeName(name);
    if (name === 'default') {
      throw MarifoldError.profileInvalid('The built-in default profile cannot be deleted.', name);
    }

    const existing = this.requireStoredProfile(name);
    if (existing.type === 'directory') {
      fs.rmSync(existing.path, { recursive: true, force: true });
    } else {
      fs.rmSync(existing.path, { force: true });
    }
    return { name, path: existing.path };
  }

  exists(name: string): boolean {
    assertSafeName(name);
    return name === 'default'
      || fs.existsSync(path.join(this.profilesDir, name))
      || fs.existsSync(path.join(this.profilesDir, `${name}.json`));
  }

  /** The profile's stored avatar image, if any (`assets/avatar.<ext>`). */
  avatar(name: string): { path: string; mediaType: string } | undefined {
    assertSafeName(name);
    return findProfileAvatar(this.profilesDir, name);
  }

  /** Store the avatar (PNG/JPEG/WebP, ≤2 MB) under assets/, replacing any
   * previous one — including one of a different extension. Creates the profile
   * dir if absent (the built-in default is served without one; mirrors
   * setAgentApproval). */
  setAvatar(name: string, image: Buffer, mediaType: string): { name: string; path: string; mediaType: string } {
    assertSafeName(name);
    const ext = AVATAR_MEDIA_TYPES[mediaType];
    if (!ext) {
      throw MarifoldError.profileInvalid(
        `Unsupported avatar type '${mediaType}'. Use image/png, image/jpeg, or image/webp.`,
        name,
      );
    }
    if (image.length === 0 || image.length > MAX_AVATAR_BYTES) {
      throw MarifoldError.profileInvalid(`Avatar images must be between 1 byte and ${MAX_AVATAR_BYTES / 1024} KB.`, name);
    }
    const profileDir = path.join(this.profilesDir, name);
    const assetsDir = path.join(profileDir, ASSETS_DIR);
    fs.mkdirSync(assetsDir, { recursive: true });
    this.removeAvatarFiles(profileDir); // clears both assets/ and any legacy root avatar
    const filePath = path.join(assetsDir, `avatar.${ext}`);
    fs.writeFileSync(filePath, image);
    return { name, path: filePath, mediaType };
  }

  deleteAvatar(name: string): { name: string; removed: boolean } {
    assertSafeName(name);
    const profileDir = path.join(this.profilesDir, name);
    if (!fs.existsSync(profileDir)) { return { name, removed: false }; }
    return { name, removed: this.removeAvatarFiles(profileDir) };
  }

  private removeAvatarFiles(profileDir: string): boolean {
    let removed = false;
    const assetsDir = path.join(profileDir, ASSETS_DIR);
    for (const ext of Object.values(AVATAR_MEDIA_TYPES)) {
      const filePath = path.join(assetsDir, `avatar.${ext}`);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        removed = true;
      }
    }
    return removed;
  }

  private requireProfileDir(name: string): string {
    const profileDir = path.join(this.profilesDir, name);
    if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
      throw MarifoldError.profileInvalid(`Profile '${name}' was not found in ${this.profilesDir}.`, name);
    }
    return profileDir;
  }

  private requireStoredProfile(name: string): { type: 'directory' | 'json'; path: string } {
    const profileDir = path.join(this.profilesDir, name);
    if (fs.existsSync(profileDir) && fs.statSync(profileDir).isDirectory()) {
      return { type: 'directory', path: profileDir };
    }

    const jsonPath = path.join(this.profilesDir, `${name}.json`);
    if (fs.existsSync(jsonPath) && fs.statSync(jsonPath).isFile()) {
      return { type: 'json', path: jsonPath };
    }

    throw MarifoldError.profileInvalid(`Profile '${name}' was not found in ${this.profilesDir}.`, name);
  }
}

/** Locate a profile's avatar file. Shared with ProfileResolver so summaries
 * can flag avatars without duplicating the media-type mapping. */
export function findProfileAvatar(profilesDir: string, name: string): { path: string; mediaType: string } | undefined {
  const assetsDir = path.join(profilesDir, name, ASSETS_DIR);
  for (const [mediaType, ext] of Object.entries(AVATAR_MEDIA_TYPES)) {
    const filePath = path.join(assetsDir, `avatar.${ext}`);
    if (fs.existsSync(filePath)) { return { path: filePath, mediaType }; }
  }
  return undefined;
}

function writeFile(filePath: string, content: string): string {
  fs.writeFileSync(filePath, content);
  return filePath;
}

function createInstructionsBackupDir(profilesDir: string, name: string, folder = '.legacy-instructions'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(profilesDir, folder, `${stamp}-${randomUUID()}`, name);
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) { fs.rmSync(tempPath, { force: true }); }
  }
}

/** Replace the `provider`/`model` keys with one `model` line, in place of the
 * first of them, or before the first table so it stays a top-level key. */
function upsertModelLine(text: string, value: string): string {
  const line = `model = ${tomlString(value)}`;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let written = false;
  let inTable = false;
  for (const current of lines) {
    if (/^\s*\[/.test(current)) {
      if (!written) {
        while (out.length > 0 && out[out.length - 1]!.trim() === '') { out.pop(); }
        out.push(...(out.length > 0 ? ['', line, ''] : [line, '']));
        written = true;
      }
      inTable = true;
    }
    if (!inTable && /^\s*(?:provider|model)\s*=/.test(current)) {
      if (!written) { out.push(line); written = true; }
      continue;
    }
    out.push(current);
  }
  const next = out.join('\n').trimEnd();
  if (written) { return `${next}\n`; }
  return next ? `${next}\n\n${line}\n` : `${line}\n`;
}

/** Drop a top-level `key = …` line, leaving tables and comments untouched. */
function removeTopLevelKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let inTable = false;
  return text.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) { inTable = true; }
    return inTable || !pattern.test(line);
  }).join('\n');
}

function upsertMode(text: string, mode: ProfileMode): string {
  const lines = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith('mode ='));
  const cleaned = lines.join('\n').trimEnd();
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}mode = ${tomlString(mode)}\n`;
}

/** Replace (or, when rendered is undefined, remove) one flat `key = value` line,
 * preserving every other line. Dotted keys (not tables) keep profile.toml a flat
 * list — no table header that would strand later flat-key writes. */
function upsertFlatLine(text: string, key: string, rendered: string | undefined): string {
  const lines = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith(`${key} =`));
  const cleaned = lines.join('\n').trimEnd();
  if (rendered === undefined) { return cleaned ? `${cleaned}\n` : PROFILE_TOML_STUB; }
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}${key} = ${rendered}\n`;
}

/** Read a string list under `[agent]` (dotted or table form parses the same). */
function parseAgentStringList(text: string, key: string): string[] {
  try {
    const parsed = parse(text) as { agent?: Record<string, unknown> };
    const existing = parsed.agent?.[key];
    if (Array.isArray(existing)) { return existing.filter((v): v is string => typeof v === 'string'); }
  } catch { /* unparseable — start fresh */ }
  return [];
}

function parseTrustedFolders(text: string): string[] {
  return parseAgentStringList(text, 'trusted_folders');
}

/** Rewrite the trusted_folders line for the given list (empty list removes it). */
function renderTrustedFolders(text: string, folders: string[]): string {
  return upsertFlatLine(
    text,
    'agent.trusted_folders',
    folders.length > 0 ? `[${folders.map(tomlString).join(', ')}]` : undefined,
  );
}

function upsertTrustedFolder(text: string, folder: string): string {
  const folders = parseTrustedFolders(text);
  if (!folders.includes(folder)) { folders.push(folder); }
  return renderTrustedFolders(text, folders);
}

/** Refuse trusting roots that would grant the agent far too much. */
function assertSafeTrustedFolder(folder: string): void {
  // Compare real locations so a symlinked home or folder cannot pass for a
  // narrower one.
  const resolved = realPathOrSelf(folder);
  const home = realPathOrSelf(os.homedir());
  const sensitive = [path.join(home, '.ssh'), path.join(home, '.marifold')];
  const tooBroad = resolved === path.parse(resolved).root // filesystem root
    || resolved === home
    // an ancestor of (or equal to) a sensitive dir.
    || sensitive.some(s => s === resolved || !path.relative(resolved, s).startsWith('..'));
  if (tooBroad) {
    throw MarifoldError.profileInvalid(`Refusing to trust '${folder}' — too broad or sensitive a folder.`, folder);
  }
}

function realPathOrSelf(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function upsertMaxContextTokens(text: string, tokens: number | undefined): string {
  const lines = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith('max_context_tokens ='));
  const cleaned = lines.join('\n').trimEnd();
  if (tokens == null || tokens <= 0) { return cleaned ? `${cleaned}\n` : PROFILE_TOML_STUB; }
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}max_context_tokens = ${Math.round(tokens)}\n`;
}

function assertSafeName(name: string): void {
  if (!SAFE_PROFILE_NAME.test(name)) {
    throw MarifoldError.profileInvalid(
      `Invalid profile name '${name}'. Use letters, numbers, underscores, or hyphens.`,
      name,
    );
  }
}

export function normalizeProfileDisplayName(value: string | undefined, profileName: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) { return undefined; }
  if (/\r|\n/.test(normalized)) {
    throw MarifoldError.profileInvalid('Profile display name must be a single line.', profileName);
  }
  if (normalized.length > 100) {
    throw MarifoldError.profileInvalid('Profile display name must be 100 characters or fewer.', profileName);
  }
  return normalized;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
