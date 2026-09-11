import type { ApiClient } from './client';

export interface WorkspaceCatalog<T> {
  defaultId: string;
  workspaces: T[];
}
/** Give outbound connections a short chance to authenticate after service start.
 * This is used only at entry selection; an active workspace never falls back. */
export async function startupWorkspaces<T extends { id: string; online: boolean }>(
  client: ApiClient,
  waitMs = 3000,
): Promise<WorkspaceCatalog<T>> {
  const until = Date.now() + waitMs;
  while (true) {
    const catalog = await client.request<WorkspaceCatalog<T>>('GET', '/v1/workspaces');
    const preferred = catalog.workspaces.find((workspace) => workspace.id === catalog.defaultId);
    if (!preferred || preferred.online || Date.now() >= until) return catalog;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
