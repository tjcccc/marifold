import type { ApiClient } from './client';
import type {
  SkillAppDefinition,
  SkillAppInstanceSnapshot,
  SkillAppMutationResult,
} from './types';

export async function listApps(
  client: ApiClient,
): Promise<SkillAppDefinition[]> {
  const payload = await client.request<{ ok: true; apps: SkillAppDefinition[] }>(
    'GET',
    '/v1/apps',
  );
  return payload.apps;
}

export async function createSkillAppInstance(
  client: ApiClient,
  appName: string,
): Promise<SkillAppInstanceSnapshot> {
  const payload = await client.request<{ ok: true; instance: SkillAppInstanceSnapshot }>(
    'POST',
    `/v1/apps/${encodeURIComponent(appName)}/instances`,
  );
  return payload.instance;
}

export async function updateSkillAppState(
  client: ApiClient,
  instanceId: string,
  values: Record<string, string>,
): Promise<SkillAppMutationResult> {
  const payload = await client.request<{ ok: true } & SkillAppMutationResult>(
    'PATCH',
    `/v1/app-instances/${encodeURIComponent(instanceId)}/state`,
    { values },
  );
  return payload;
}

export async function runSkillAppOperation(
  client: ApiClient,
  instanceId: string,
  operationName: string,
): Promise<SkillAppMutationResult> {
  const payload = await client.request<{ ok: true } & SkillAppMutationResult>(
    'POST',
    `/v1/app-instances/${encodeURIComponent(instanceId)}/operations/${encodeURIComponent(operationName)}`,
  );
  return payload;
}

export async function deleteSkillAppInstance(
  client: ApiClient,
  instanceId: string,
): Promise<void> {
  await client.request('DELETE', `/v1/app-instances/${encodeURIComponent(instanceId)}`);
}
