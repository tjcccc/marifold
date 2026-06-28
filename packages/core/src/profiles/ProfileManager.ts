import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { ensureProfileMemoryFiles } from '../memory/MemoryStore';
import type { ProfileMode } from '../config/ConfigSchema';

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

const PROFILE_MD_STUB = `# {name}

You are a helpful assistant.
`;

const RULES_MD_STUB = `# RULES.md

Be honest. Do not make things up.
Be concise unless the user asks for depth.

Replace this content with specific guidance for this profile's role.
`;

/** Documented per-profile config template. Shared by `profile create` and the
 * default profile scaffolded at `marifold init`, so both list every option. */
export const PROFILE_TOML_STUB = `# profile.toml — per-profile overrides. Every key is optional; uncomment to set.
# Anything left commented falls back to the global [default] in config.toml.

# Provider + model override (set BOTH or NEITHER). Blank = use [default].
# provider = "ollama"
# model = "gemma4:e4b"

# Default TUI mode for this profile: "agent" or "chat" (default "agent").
# mode = "agent"

# Load this profile's structured memory into context (default true).
# memories = true

# Thinking for this profile (default off). On = stronger reasoning, slower and
# more expensive. Toggle per session with /think on|off.
# think = false

# Conversation-context budget in tokens; enables compaction past ~80%.
# Falls back to default.max_context_tokens.
# max_context_tokens = 16000

# Hard cap on recent session turns replayed each request: "all" = no cap,
# N = last N, 0 = none. Falls back to default.session_context_turns.
# session_context_turns = "all"
`;

export interface ProfileInitResult {
  name: string;
  path: string;
  files: string[];
}

export interface ProfileModelOverrideResult {
  name: string;
  path: string;
  provider?: string;
  model?: string;
  cleared: boolean;
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
    assertSafeName(name);
    const profileDir = path.join(this.profilesDir, name);
    if (fs.existsSync(profileDir)) {
      throw MarifoldError.profileInvalid(`Profile '${name}' already exists at ${profileDir}.`, name);
    }

    fs.mkdirSync(profileDir, { recursive: true });
    const files = [
      writeFile(path.join(profileDir, 'PROFILE.md'), PROFILE_MD_STUB.replace('{name}', name)),
      writeFile(path.join(profileDir, 'RULES.md'), RULES_MD_STUB),
      writeFile(path.join(profileDir, 'CUSTOM.md'), ''),
      writeFile(path.join(profileDir, 'profile.toml'), PROFILE_TOML_STUB),
      ...ensureProfileMemoryFiles(profileDir).map(file => file.path),
    ];

    return { name, path: profileDir, files };
  }

  setModelOverride(name: string, provider: string, model: string): ProfileModelOverrideResult {
    assertSafeName(name);
    if (!provider || !model) {
      throw MarifoldError.profileInvalid('Profile model overrides require both provider and model.', name);
    }
    const profileDir = this.requireProfileDir(name);
    const profileToml = path.join(profileDir, 'profile.toml');
    const next = upsertProfileToml(fs.existsSync(profileToml) ? fs.readFileSync(profileToml, 'utf-8') : '', provider, model);
    fs.writeFileSync(profileToml, next);
    return { name, path: profileToml, provider, model, cleared: false };
  }

  clearModelOverride(name: string): ProfileModelOverrideResult {
    assertSafeName(name);
    const profileDir = this.requireProfileDir(name);
    const profileToml = path.join(profileDir, 'profile.toml');
    if (!fs.existsSync(profileToml)) {
      fs.writeFileSync(profileToml, PROFILE_TOML_STUB);
    } else {
      fs.writeFileSync(profileToml, removeModelOverride(fs.readFileSync(profileToml, 'utf-8')));
    }
    return { name, path: profileToml, cleared: true };
  }

  /** Persist the profile's default TUI mode into its profile.toml, preserving
   * every other key. Used by the TUI's `/agent default` / `/chat default`. */
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

  rename(from: string, to: string): ProfileRenameResult {
    assertSafeName(from);
    assertSafeName(to);
    if (from === to) throw MarifoldError.profileInvalid('New profile name must be different from the current name.', from);
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

function writeFile(filePath: string, content: string): string {
  fs.writeFileSync(filePath, content);
  return filePath;
}

function upsertProfileToml(text: string, provider: string, model: string): string {
  const cleaned = removeModelOverride(text).trimEnd();
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}provider = ${tomlString(provider)}\nmodel = ${tomlString(model)}\n`;
}

function upsertMode(text: string, mode: ProfileMode): string {
  const lines = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith('mode ='));
  const cleaned = lines.join('\n').trimEnd();
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}mode = ${tomlString(mode)}\n`;
}

function upsertMaxContextTokens(text: string, tokens: number | undefined): string {
  const lines = text.split(/\r?\n/).filter(line => !line.trimStart().startsWith('max_context_tokens ='));
  const cleaned = lines.join('\n').trimEnd();
  if (tokens == null || tokens <= 0) return cleaned ? `${cleaned}\n` : PROFILE_TOML_STUB;
  const prefix = cleaned ? `${cleaned}\n\n` : '';
  return `${prefix}max_context_tokens = ${Math.round(tokens)}\n`;
}

function removeModelOverride(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith('provider =') && !trimmed.startsWith('model =');
  });
  const next = lines.join('\n').trimEnd();
  return next ? `${next}\n` : PROFILE_TOML_STUB;
}

function assertSafeName(name: string): void {
  if (!SAFE_PROFILE_NAME.test(name)) {
    throw MarifoldError.profileInvalid(
      `Invalid profile name '${name}'. Use letters, numbers, underscores, or hyphens.`,
      name,
    );
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
