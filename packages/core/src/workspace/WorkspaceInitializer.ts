import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { ProviderType } from '../config/ConfigSchema';
import { ensureProfileMemoryFiles } from '../memory/MemoryStore';
import {
  defaultConfigPath,
  defaultProfilesDir,
  defaultSessionsDb,
  defaultSchedulesDir,
  defaultSkillsDir,
  defaultTasksDir,
  resolveUserPath,
} from './WorkspacePaths';

const SAFE_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

const DEFAULT_PROFILE = `# PROFILE.md

You are Marifold, a local-first personal AI workspace assistant.
`;

const DEFAULT_RULES = `# RULES.md

Answer clearly and practically.
Do not claim unsupported capabilities.
`;

const DEFAULT_CUSTOM = '';

const DEFAULT_PROFILE_TOML = `# Optional per-profile model override.
# Set both provider and model to override [default].

memories = true

# provider = "ollama"
# model = "gemma4:e4b"
`;

export type WorkspaceInitFileStatus = 'created' | 'updated' | 'kept';

export interface WorkspaceInitFile {
  path: string;
  status: WorkspaceInitFileStatus;
}

export interface WorkspaceInitOptions {
  configPath?: string;
  provider?: string;
  providerType?: ProviderType;
  model?: string;
  profile?: string;
  profilesDir?: string;
  sessionsDb?: string;
  tasksDir?: string;
  schedulesDir?: string;
  skillsDir?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  force?: boolean;
}

export interface WorkspaceInitResult {
  configPath: string;
  profilesDir: string;
  sessionsDb: string;
  tasksDir: string;
  schedulesDir: string;
  skillsDir: string;
  provider: string;
  providerType: ProviderType;
  model: string;
  profile: string;
  files: WorkspaceInitFile[];
}

export class WorkspaceInitializer {
  initialize(options: WorkspaceInitOptions = {}): WorkspaceInitResult {
    const configPath = resolveUserPath(options.configPath ?? defaultConfigPath());
    if (fs.existsSync(configPath) && !options.force) {
      throw MarifoldError.workspaceAlreadyInitialized(configPath);
    }

    const provider = options.provider ?? 'ollama';
    const providerType = options.providerType ?? inferProviderType(provider);
    const model = resolveModel(provider, options.model);
    const profile = options.profile ?? 'default';
    assertSafeProfileName(profile);

    const profilesDir = resolveUserPath(options.profilesDir ?? defaultProfilesDir());
    const sessionsDb = resolveUserPath(options.sessionsDb ?? defaultSessionsDb());
    const tasksDir = resolveUserPath(options.tasksDir ?? defaultTasksDir());
    const schedulesDir = resolveUserPath(options.schedulesDir ?? defaultSchedulesDir());
    const skillsDir = resolveUserPath(options.skillsDir ?? defaultSkillsDir());
    const baseUrl = resolveBaseUrl(provider, providerType, options.baseUrl);
    const apiKeyEnv = resolveApiKeyEnv(provider, providerType, options.apiKeyEnv);

    const files: WorkspaceInitFile[] = [];
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(path.dirname(sessionsDb), { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(schedulesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    const configStatus: WorkspaceInitFileStatus = fs.existsSync(configPath) ? 'updated' : 'created';
    fs.writeFileSync(configPath, renderConfig({
      provider,
      providerType,
      model,
      profile,
      profilesDir,
      sessionsDb,
      tasksDir,
      schedulesDir,
      skillsDir,
      baseUrl,
      apiKeyEnv,
    }));
    files.push({ path: configPath, status: configStatus });

    const profileDir = path.join(profilesDir, profile);
    fs.mkdirSync(profileDir, { recursive: true });
    files.push(writeIfMissing(path.join(profileDir, 'PROFILE.md'), DEFAULT_PROFILE));
    files.push(writeIfMissing(path.join(profileDir, 'RULES.md'), DEFAULT_RULES));
    files.push(writeIfMissing(path.join(profileDir, 'CUSTOM.md'), DEFAULT_CUSTOM));
    files.push(writeIfMissing(path.join(profileDir, 'profile.toml'), DEFAULT_PROFILE_TOML));
    files.push(...ensureProfileMemoryFiles(profileDir));

    return {
      configPath,
      profilesDir,
      sessionsDb,
      tasksDir,
      schedulesDir,
      skillsDir,
      provider,
      providerType,
      model,
      profile,
      files,
    };
  }
}

interface RenderConfigOptions {
  provider: string;
  providerType: ProviderType;
  model: string;
  profile: string;
  profilesDir: string;
  sessionsDb: string;
  tasksDir: string;
  schedulesDir: string;
  skillsDir: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

function renderConfig(options: RenderConfigOptions): string {
  const providerLines = [
    `[providers.${options.provider}]`,
    `type = ${tomlString(options.providerType)}`,
  ];
  if (options.baseUrl) providerLines.push(`base_url = ${tomlString(options.baseUrl)}`);
  if (options.apiKeyEnv) providerLines.push(`api_key_env = ${tomlString(options.apiKeyEnv)}`);

  return `[default]
provider = ${tomlString(options.provider)}
model = ${tomlString(options.model)}
profile = ${tomlString(options.profile)}
timeout_seconds = 120
think = false

[models]
options = [
  ${tomlString(`${options.provider}/${options.model}`)},
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = ${tomlString(options.profilesDir)}
sessions_db = ${tomlString(options.sessionsDb)}
tasks_dir = ${tomlString(options.tasksDir)}
schedules_dir = ${tomlString(options.schedulesDir)}
skills_dir = ${tomlString(options.skillsDir)}

${providerLines.join('\n')}
`;
}

function inferProviderType(provider: string): ProviderType {
  if (provider === 'ollama') return 'ollama';
  if (provider === 'anthropic') return 'anthropic';
  return 'openai-compatible';
}

function resolveModel(provider: string, model?: string): string {
  if (model) return model;
  if (provider === 'ollama') return 'gemma4:e4b';
  throw MarifoldError.configInvalid(`Provider '${provider}' requires --model during init.`);
}

function resolveBaseUrl(provider: string, providerType: ProviderType, baseUrl?: string): string | undefined {
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  if (providerType === 'ollama') return 'http://localhost:11434';
  if (provider === 'openai') return 'https://api.openai.com';
  if (providerType === 'openai-compatible') {
    throw MarifoldError.configInvalid(
      `Provider '${provider}' requires --base-url during init because it is OpenAI-compatible.`,
      { provider },
    );
  }
  return undefined;
}

function resolveApiKeyEnv(provider: string, providerType: ProviderType, apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv) return apiKeyEnv;
  if (providerType === 'ollama') return undefined;
  return `${provider.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
}

function assertSafeProfileName(profile: string): void {
  if (!SAFE_PROFILE_NAME.test(profile)) {
    throw MarifoldError.profileInvalid(
      `Invalid profile name '${profile}'. Use letters, numbers, underscores, or hyphens.`,
      profile,
    );
  }
}

function writeIfMissing(filePath: string, content: string): WorkspaceInitFile {
  if (fs.existsSync(filePath)) return { path: filePath, status: 'kept' };
  fs.writeFileSync(filePath, content);
  return { path: filePath, status: 'created' };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
