// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { MarifoldApiError } from '../../src/api/client';
import type { ProfileDetail, RunRecord, SessionSummary } from '../../src/api/types';
import { useAgentController } from '../../src/screens/agent/useAgentController';

afterEach(cleanup);

const profile: ProfileDetail = {
  name: 'prompt-maker',
  source: 'directory',
  settings: { memories: true, mode: 'agent' },
  files: {
    profile: { content: '' },
    rules: { content: '' },
    custom: { content: '' },
    profileToml: { content: 'mode = "agent"' },
  },
};

describe('useAgentController session lifecycle', () => {
  it('keeps the root Agent route on the profile picker', async () => {
    const client: ApiClient = {
      baseUrl: '',
      request: async (method, path) => {
        if (method === 'GET' && path === '/v1/profiles') return { profiles: [profile] } as never;
        if (method === 'GET' && path === '/v1/models') return { default: {}, options: [] } as never;
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      stream: async () => new Response(),
      blob: async () => undefined,
    };
    const navigate = vi.fn();
    const { result } = renderHook(() => useAgentController({
      client,
      route: { view: 'agent' },
      navigate,
      onUnauthorized: vi.fn(),
    }));

    await waitFor(() => expect(result.current.profiles).toHaveLength(1));
    expect(result.current.profileName).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a pending new session, then replaces it from the server when the run completes', async () => {
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>(resolve => { releaseStream = resolve; });
    let serverHasSession = false;
    const durable: SessionSummary = {
      id: 'session_new',
      profileName: 'prompt-maker',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
      turnCount: 2,
      preview: 'My first prompt',
    };
    const run: RunRecord = {
      id: 'run_1',
      objective: 'My first prompt',
      profile: 'prompt-maker',
      sessionId: 'session_new',
      status: 'running',
      createdAt: '2026-07-22T00:00:00.000Z',
      eventCount: 0,
      pendingApprovals: [],
    };

    const client: ApiClient = {
      baseUrl: '',
      request: async (method, path) => {
        if (method === 'GET' && path === '/v1/profiles') return { profiles: [profile] } as never;
        if (method === 'GET' && path === '/v1/status') {
          return { service: 'marifold', apiVersion: 'v1', configPath: '', foundConfig: true, default: { profile: 'prompt-maker' } } as never;
        }
        if (method === 'GET' && path === '/v1/models') return { default: {}, options: [] } as never;
        if (method === 'GET' && path === '/v1/profiles/prompt-maker') return { profile } as never;
        if (method === 'GET' && path === '/v1/skills?profile=prompt-maker') return { skills: [] } as never;
        if (method === 'GET' && path === '/v1/sessions?limit=50&profile=prompt-maker') {
          return { sessions: serverHasSession ? [durable] : [] } as never;
        }
        if (method === 'GET' && path === '/v1/sessions/session_new') {
          throw new MarifoldApiError(404, { code: 'NOT_FOUND', message: 'not persisted yet' });
        }
        if (method === 'GET' && path === '/v1/runs') return { runs: [] } as never;
        if (method === 'POST' && path === '/v1/runs') return { run } as never;
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      stream: async path => {
        expect(path).toBe('/v1/runs/run_1/events');
        await streamReleased;
        serverHasSession = true;
        const done = { type: 'done', taskId: 'task_1', status: 'completed' };
        return new Response(`id: 1\nevent: done\ndata: ${JSON.stringify(done)}\n\n`, { status: 200 });
      },
      blob: async () => undefined,
    };

    const navigate = vi.fn();
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useAgentController({
      client,
      route: { view: 'agent', profile: 'prompt-maker', session: 'session_new' },
      navigate,
      onUnauthorized,
    }));
    await waitFor(() => expect(result.current.profileDetail?.name).toBe('prompt-maker'));

    let send!: Promise<void>;
    act(() => { send = result.current.send('My first prompt'); });
    await send;
    await waitFor(() => expect(result.current.sessions[0]?.id).toBe('session_new'));
    expect(result.current.sessions[0]).toMatchObject({
      id: 'session_new',
      preview: 'My first prompt',
      turnCount: 1,
    });

    act(() => releaseStream());
    await waitFor(() => expect(result.current.sessions[0]).toEqual(durable));
  });
});
