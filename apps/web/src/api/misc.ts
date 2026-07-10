import type { ApiClient } from './client';
import type { PublicConfig } from './types';

export interface ServiceStatus {
  service: string;
  apiVersion: string;
  configPath: string;
  foundConfig: boolean;
  default: { provider?: string; model?: string; profile: string };
}

export async function getStatus(client: ApiClient): Promise<ServiceStatus> {
  return client.request<ServiceStatus>('GET', '/v1/status');
}

export async function getConfig(client: ApiClient): Promise<PublicConfig> {
  const body = await client.request<{ config: PublicConfig }>('GET', '/v1/config');
  return body.config;
}

export interface ModelsView {
  default: { provider?: string; model?: string };
  options: string[];
}

export async function getModels(client: ApiClient): Promise<ModelsView> {
  return client.request('GET', '/v1/models');
}

/** Sanitized live reachability per provider (GET /v1/providers/status). */
export interface ProviderStatusEntry {
  name: string;
  type: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  isDefault: boolean;
  configured: boolean;
  reachable: boolean | null;
  modelCount?: number;
  models: string[];
  message: string;
}

export async function getProviderStatus(client: ApiClient): Promise<ProviderStatusEntry[]> {
  const body = await client.request<{ providers: ProviderStatusEntry[] }>('GET', '/v1/providers/status');
  return body.providers;
}

/** A skill for the composer's $-autocomplete (GET /v1/skills). */
export interface SkillHint {
  name: string;
  description: string;
  /** e.g. "$translate <text> [language]". */
  usage: string;
}

export async function getSkills(client: ApiClient, profile?: string): Promise<SkillHint[]> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  const body = await client.request<{ skills: SkillHint[] }>('GET', `/v1/skills${query}`);
  return body.skills;
}

export interface ProviderModels {
  provider: string;
  reachable: boolean | null;
  models: string[];
  message: string;
}

export async function getProviderModels(client: ApiClient, provider: string): Promise<ProviderModels> {
  return client.request('GET', `/v1/providers/${encodeURIComponent(provider)}/models`);
}

export interface AddModelInput {
  provider: string;
  model: string;
  type?: string;
  baseUrl?: string;
  /** Env-var *name* — raw keys are rejected from the wire by design. */
  apiKeyEnv?: string;
}

export async function addModel(client: ApiClient, input: AddModelInput): Promise<ModelsView> {
  return client.request('POST', '/v1/models', input);
}

export async function removeModel(
  client: ApiClient,
  provider: string,
  model: string,
): Promise<ModelsView & { removed: boolean; wasDefault: boolean }> {
  return client.request('DELETE', '/v1/models', { provider, model });
}

export async function setDefaultModel(client: ApiClient, provider: string, model: string): Promise<ModelsView> {
  return client.request('PUT', '/v1/models/default', { provider, model });
}

/** PATCH /v1/config — one dotted key, CLI `config set` semantics. */
export async function setConfigValue(client: ApiClient, key: string, value: string): Promise<PublicConfig> {
  const body = await client.request<{ config: PublicConfig }>('PATCH', '/v1/config', { key, value });
  return body.config;
}
