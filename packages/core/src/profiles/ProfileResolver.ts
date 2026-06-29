import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'smol-toml';
import { Profile, ProfileLoader } from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { ProfileDetail, ProfileFileSummary, ProfileMode, ProfileSettings, ProfileSummary } from '../config/ConfigSchema';
import { parsePartialAgentConfig } from '../config/ConfigLoader';

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

const BUILT_IN_DEFAULT_PROFILE: Profile = {
  name: 'default',
  identity: 'You are Marifold, a local-first personal AI workspace assistant.',
  rules: 'Answer clearly and practically. Do not claim unsupported capabilities.',
  custom: '',
  memories: [],
};

type TomlObject = Record<string, unknown>;

export class ProfileResolver implements ProfileLoader {
  constructor(private readonly profilesDir: string) {}

  load(name: string): Profile {
    this.assertSafeName(name);
    const directoryProfile = this.loadDirectoryProfile(name);
    if (directoryProfile) return directoryProfile;

    const jsonProfile = this.loadJsonProfile(name);
    if (jsonProfile) return jsonProfile;

    if (name === 'default') return { ...BUILT_IN_DEFAULT_PROFILE };
    throw MarifoldError.profileInvalid(`Profile '${name}' was not found in ${this.profilesDir}.`, name);
  }

  loadSettings(name: string): ProfileSettings {
    this.assertSafeName(name);
    const profileToml = path.join(this.profilesDir, name, 'profile.toml');
    if (!fs.existsSync(profileToml)) return { memories: true };

    const raw = this.readToml(profileToml);
    const provider = optionalString(raw.provider, `${name}.profile.toml provider`);
    const model = optionalString(raw.model, `${name}.profile.toml model`);
    const memories = optionalBoolean(raw.memories, `${name}.profile.toml memories`) ?? true;
    const maxContextTokens = optionalNumber(raw.max_context_tokens, `${name}.profile.toml max_context_tokens`);
    const sessionContextTurns = optionalTurnWindow(raw.session_context_turns, `${name}.profile.toml session_context_turns`);
    const think = optionalBoolean(raw.think, `${name}.profile.toml think`);
    const agent = raw.agent !== undefined ? parsePartialAgentConfig(raw.agent, `${name}.profile.toml [agent]`) : undefined;
    const rawMode = optionalString(raw.mode, `${name}.profile.toml mode`);
    if (rawMode !== undefined && rawMode !== 'agent' && rawMode !== 'chat') {
      throw MarifoldError.profileInvalid(
        `Profile '${name}' has an invalid mode '${rawMode}' in profile.toml; use "agent" or "chat".`,
        name,
      );
    }
    if ((provider && !model) || (!provider && model)) {
      throw MarifoldError.profileInvalid(
        `Profile '${name}' must set both provider and model in profile.toml, or neither.`,
        name,
      );
    }
    return { provider, model, memories, mode: rawMode as ProfileMode | undefined, maxContextTokens, sessionContextTurns, think, agent };
  }

  list(): ProfileSummary[] {
    const profiles = new Map<string, ProfileSummary>();
    if (fs.existsSync(this.profilesDir)) {
      for (const entry of fs.readdirSync(this.profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && SAFE_PROFILE_NAME.test(entry.name)) {
          const profilePath = path.join(this.profilesDir, entry.name);
          if (isProfileDirectory(profilePath)) {
            profiles.set(entry.name, { name: entry.name, source: 'directory', path: profilePath });
          }
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const name = entry.name.slice(0, -'.json'.length);
          if (SAFE_PROFILE_NAME.test(name) && !profiles.has(name)) {
            profiles.set(name, {
              name,
              source: 'json',
              path: path.join(this.profilesDir, entry.name),
            });
          }
        }
      }
    }

    if (!profiles.has('default')) {
      profiles.set('default', { name: 'default', source: 'built-in' });
    }

    return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  detail(name: string): ProfileDetail {
    this.assertSafeName(name);
    const summary = this.list().find(profile => profile.name === name);
    if (!summary) {
      throw MarifoldError.profileInvalid(`Profile '${name}' was not found in ${this.profilesDir}.`, name);
    }

    if (summary.source === 'directory' && summary.path) {
      return {
        ...summary,
        settings: this.loadSettings(name),
        files: {
          profile: readProfileFile(path.join(summary.path, 'PROFILE.md')),
          rules: readProfileFile(path.join(summary.path, 'RULES.md')),
          custom: readProfileFile(path.join(summary.path, 'CUSTOM.md')),
          profileToml: readProfileFile(path.join(summary.path, 'profile.toml')),
        },
      };
    }

    if (summary.source === 'json' && summary.path) {
      const profile = this.loadJsonProfile(name);
      return {
        ...summary,
        settings: { memories: true },
        files: {
          profile: { path: summary.path, content: profile?.identity ?? '' },
          rules: { path: summary.path, content: profile?.rules ?? '' },
          custom: { path: summary.path, content: profile?.custom ?? '' },
          profileToml: { content: '' },
        },
      };
    }

    return {
      ...summary,
      settings: { memories: true },
      files: {
        profile: { content: BUILT_IN_DEFAULT_PROFILE.identity },
        rules: { content: BUILT_IN_DEFAULT_PROFILE.rules },
        custom: { content: BUILT_IN_DEFAULT_PROFILE.custom ?? '' },
        profileToml: { content: '' },
      },
    };
  }

  private loadDirectoryProfile(name: string): Profile | undefined {
    const profileDir = path.join(this.profilesDir, name);
    if (!isProfileDirectory(profileDir)) return undefined;
    return {
      name,
      identity: readOptional(path.join(profileDir, 'PROFILE.md')),
      rules: readOptional(path.join(profileDir, 'RULES.md')),
      custom: readOptional(path.join(profileDir, 'CUSTOM.md')),
      memories: [],
    };
  }

  private loadJsonProfile(name: string): Profile | undefined {
    const filePath = path.join(this.profilesDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<Profile>;
      return {
        name,
        identity: raw.identity ?? '',
        rules: raw.rules ?? '',
        custom: raw.custom,
        memories: raw.memories ?? [],
      };
    } catch (error) {
      throw MarifoldError.profileInvalid(`Profile '${name}' JSON is invalid: ${String(error)}`, name);
    }
  }

  private readToml(filePath: string): TomlObject {
    try {
      const value = parse(fs.readFileSync(filePath, 'utf-8'));
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as TomlObject;
      }
      throw new Error('TOML root must be an object.');
    } catch (error) {
      throw MarifoldError.profileInvalid(`Could not read profile config ${filePath}: ${String(error)}`, path.basename(path.dirname(filePath)));
    }
  }

  private assertSafeName(name: string): void {
    if (!SAFE_PROFILE_NAME.test(name)) {
      throw MarifoldError.profileInvalid(
        `Invalid profile name '${name}'. Use letters, numbers, underscores, or hyphens.`,
        name,
      );
    }
  }
}

function isProfileDirectory(profileDir: string): boolean {
  return fs.existsSync(profileDir) && fs.statSync(profileDir).isDirectory()
    && (
      fs.existsSync(path.join(profileDir, 'PROFILE.md'))
      || fs.existsSync(path.join(profileDir, 'RULES.md'))
      || fs.existsSync(path.join(profileDir, 'CUSTOM.md'))
      || fs.existsSync(path.join(profileDir, 'profile.toml'))
    );
}

function readOptional(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

function readProfileFile(filePath: string): ProfileFileSummary {
  return {
    path: filePath,
    content: readOptional(filePath),
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a string.`);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a boolean.`);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a number.`);
}

/** Parse `session_context_turns`: `"all"` (or unset) → undefined (no cap),
 *  a non-negative integer → that many recent turns. */
function optionalTurnWindow(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a non-negative integer or "all".`);
}
