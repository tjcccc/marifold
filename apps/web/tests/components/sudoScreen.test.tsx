// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentScreen } from '../../src/screens/agent/AgentScreen';
import { useAgentController } from '../../src/screens/agent/useAgentController';
import type { AgentController } from '../../src/screens/agent/useAgentController';
import type { ApiClient } from '../../src/api/client';
import { answerApproval } from '../../src/api/runs';

vi.mock('../../src/screens/agent/useAgentController', () => ({ useAgentController: vi.fn() }));
const require = createRequire(import.meta.url);
const { SudoCredentials } = require('../../../../packages/core/dist/agent/SudoCredentials');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('carries a password encrypted by the full Agent screen to the approval HTTP body', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const credentials = new SudoCredentials();
  const sudo = credentials.create('id -u');
  const request = vi.fn(async (_method: string, _path: string, _body?: unknown) => ({ apps: [] }));
  const client = { request, baseUrl: '' } as unknown as ApiClient;
  const answer = vi.fn((runId, requestId, action, response) => answerApproval(client, runId, requestId, action, response));
  vi.mocked(useAgentController).mockReturnValue({
    profileName: 'tester', profiles: [], sessions: [], skills: [], devices: [], modelOptions: [], attachments: [],
    runningSessionIds: new Set(), sessionSearch: '', thread: { catchUp: [], discardedRunIds: [], seq: 0, items: [{
      id: 'run', kind: 'run', run: { runId: 'run', status: 'waiting_approval', startedAt: new Date().toISOString(), lastSeq: 0,
        rows: [], inputResponses: [], steering: [], denials: [], errors: [], artifacts: [], collapsed: false,
        approval: { id: 'approval', tool: 'sudo_exec', kind: 'shell', summary: 'id -u', input: { command: 'id -u' }, escalated: true, persistable: false, sudo },
      },
    }] }, answer,
  } as unknown as AgentController);
  render(<AgentScreen client={client} route={{ view: 'agent', profile: 'tester' }} navigate={vi.fn()}
    onUnauthorized={vi.fn()} theme="light" onThemeChange={vi.fn()} onOpenConnection={vi.fn()} onOpenSettings={vi.fn()}
    connectionId="local" connectionName="Local" workspaceView="agent" onWorkspaceViewChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(`Password for ${sudo.account} on ${sudo.device}`), { target: { value: 'screen-secret-canary' } });
  fireEvent.click(screen.getByText('Authorize sudo once'));
  await waitFor(() => expect(answer).toHaveBeenCalledOnce());
  const call = request.mock.calls.find(args => args[1] === '/v1/runs/run/approvals/approval')!;
  expect(call).toBeDefined();
  const body = call[2] as { action: string; sudoResponse: unknown };
  expect(body.action).toBe('once');
  expect(JSON.stringify(request.mock.calls)).not.toContain('screen-secret-canary');
  const password = credentials.consume('id -u', body.sudoResponse);
  expect(password.toString()).toBe('screen-secret-canary');
  password.fill(0);
});
