import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { ProjectDetail } from '../../src/api/types';
import { type AgentCommandContext, runAgentCommand } from '../../src/screens/agent/agentCommands';

const project = { id: 'proj_1', name: 'Game', lead: 'default', members: ['default'] } as ProjectDetail;

function context(overrides: Partial<AgentCommandContext> = {}) {
  const invited = { ...project, members: ['default', 'painter'] };
  const request = vi.fn(async () => ({ project: invited }));
  const dispatch = vi.fn();
  const onProjectChange = vi.fn();
  const value = {
    client: { request } as unknown as ApiClient,
    dispatch,
    threadRef: { current: { items: [] } },
    profileName: 'default',
    profileDetail: undefined,
    modelChoice: undefined,
    deep: false,
    sessionId: undefined,
    newSession: vi.fn(),
    setDeep: vi.fn(),
    setModelChoice: vi.fn(),
    sendMessage: vi.fn(),
    refreshSessions: vi.fn(),
    handleError: vi.fn(),
    stop: vi.fn(),
    onProjectChange,
    ...overrides,
  } as unknown as AgentCommandContext;
  return { value, request, dispatch, onProjectChange, invited };
}

describe('project commands', () => {
  it('invites the named profile and shows the new roster', async () => {
    const { value, request, onProjectChange, dispatch, invited } = context({ project });
    await runAgentCommand(value, { name: 'invite', args: '@painter' });
    expect(request).toHaveBeenCalledWith('POST', '/v1/projects/proj_1/members', { profile: 'painter' });
    expect(onProjectChange).toHaveBeenCalledWith(invited);
    expect(dispatch).toHaveBeenCalledWith({ type: 'notice', tone: 'info', text: 'painter joined Game.' });
  });

  it('works only in a project', async () => {
    const { value, request, dispatch } = context();
    await runAgentCommand(value, { name: 'dismiss', args: '@painter' });
    expect(request).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'notice', tone: 'warn', text: '/dismiss works in a project session.' });
  });
});
