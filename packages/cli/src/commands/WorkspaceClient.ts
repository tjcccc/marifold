import { createApiClient, followRunEvents, startupWorkspaces, type ApiClient } from '@marifold/client';
import type { AgentEvent, AgentRunOptions, RunRecord, WorkspaceSummary } from '@marifold/core';
import type { Command } from 'commander';
import { loadConfig } from './RuntimeFactory';
import { localServiceSettings } from './workspace';
export async function workspaceClient(
  program: Command,
  selected?: string,
  device?: string,
): Promise<ApiClient | undefined> {
  let settings;
  try {
    settings = localServiceSettings(loadConfig(program));
  } catch (error) {
    if ((selected && selected !== 'local') || device) throw error;
    return undefined;
  }
  const local = createApiClient(settings);
  if (selected === 'local') {
    if (device) throw new Error('Select a workspace before choosing an execution device.');
    return undefined;
  }
  const result = await startupWorkspaces<WorkspaceSummary>(local);
  const target = selected ?? result.defaultId;
  if (target === 'local') {
    if (device) throw new Error('Select a workspace before choosing an execution device.');
    return undefined;
  }
  const matches = result.workspaces.filter((w) => w.id === target || w.name === target);
  if (matches.length !== 1)
    throw new Error(matches.length ? 'Workspace name is ambiguous; use its ID.' : 'Workspace not found.');
  if (!matches[0]!.online) {
    if (selected || device) throw new Error('Workspace host is offline.');
    process.stderr.write('Default workspace is offline. Using Local for this command.\n');
    return undefined;
  }
  return createApiClient({ ...settings, workspaceId: matches[0]!.id, executionDevice: () => device });
}
export async function* remoteAgent(
  api: ApiClient,
  options: AgentRunOptions,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { approvalHandler, userInputHandler, signal, steering: _steering, ...input } = options;
  if (signal?.aborted) return;
  const { run } = await api.request<{ run: RunRecord }>('POST', '/v1/runs', input);
  process.stderr.write(
    `Run ${run.id}${run.execution ? ` · execution device ${run.execution.executionDeviceId}` : ''}\n`,
  );
  const post = (path: string, body: unknown) => api.request('POST', `/v1/runs/${run.id}/${path}`, body);
  const cancel = () => {
    void post('cancel', {}).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for await (const event of followRunEvents<AgentEvent>(api, run.id, signal)) {
      yield event;
      if (event.type === 'approval_request')
        void Promise.resolve(approvalHandler?.(event.request))
          .then((decision) => post(`approvals/${event.request.id}`, { action: decision?.approved ? 'once' : 'deny' }))
          .catch((error) => process.stderr.write(`Approval could not be delivered: ${error.message}\n`));
      if (event.type === 'user_input_request')
        void Promise.resolve(userInputHandler?.(event.request))
          .then((submission) => post(`inputs/${event.request.id}`, submission ?? { skipped: true }))
          .catch(() => undefined);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
