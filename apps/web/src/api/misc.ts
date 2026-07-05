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

export async function getModels(
  client: ApiClient,
): Promise<{ default: { provider?: string; model?: string }; options: string[] }> {
  return client.request('GET', '/v1/models');
}
