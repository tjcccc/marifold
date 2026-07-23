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
        if (method === 'GET' && path === '/v1/sessions?limit=100&profile=prompt-maker&archived=false') {
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

  it('rehydrates persisted image and inlined file attachments when a session is reopened', async () => {
    const summary: SessionSummary = {
      id: 'session_image',
      profileName: 'prompt-maker',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
      turnCount: 2,
      preview: 'Describe this',
    };
    const client: ApiClient = {
      baseUrl: '',
      request: async (method, path) => {
        if (method === 'GET' && path === '/v1/profiles') return { profiles: [profile] } as never;
        if (method === 'GET' && path === '/v1/models') return { default: {}, options: [] } as never;
        if (method === 'GET' && path === '/v1/profiles/prompt-maker') return { profile } as never;
        if (method === 'GET' && path === '/v1/skills?profile=prompt-maker') return { skills: [] } as never;
        if (method === 'GET' && path === '/v1/sessions?limit=100&profile=prompt-maker&archived=false') {
          return { sessions: [summary] } as never;
        }
        if (method === 'GET' && path === '/v1/sessions/session_image') {
          return {
            session: {
              ...summary,
              turns: [
                {
                  role: 'user',
                  content: 'Describe this\n\nAttached file: brief.docx\n```\nProject brief\n```',
                  timestamp: '2026-07-22T00:00:00.000Z',
                  attachments: [{
                    kind: 'image',
                    mediaType: 'image/png',
                    ref: { userTurnIndex: 0, attachmentIndex: 0 },
                  }],
                },
                { role: 'assistant', content: 'A portrait.', timestamp: '2026-07-22T00:00:01.000Z' },
              ],
            },
          } as never;
        }
        if (method === 'GET' && path === '/v1/runs') return { runs: [] } as never;
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      stream: async () => new Response(),
      blob: async path => path.endsWith('/attachments/0/0')
        ? new Blob(['image-bytes'], { type: 'image/png' })
        : undefined,
    };

    const { result } = renderHook(() => useAgentController({
      client,
      route: { view: 'agent', profile: 'prompt-maker', session: 'session_image' },
      navigate: vi.fn(),
      onUnauthorized: vi.fn(),
    }));

    await waitFor(() => expect(result.current.thread.items).toHaveLength(2));
    expect(result.current.thread.items[0]).toMatchObject({
      kind: 'user',
      text: 'Describe this',
      attachments: [
        {
          kind: 'image',
          name: 'Image 1',
          sourcePath: '/v1/sessions/session_image/attachments/0/0',
        },
        {
          kind: 'text',
          name: 'brief.docx',
          content: 'Project brief',
          officeKind: 'word',
        },
      ],
    });
  });

  it('updates session actions and leaves a deleted selected session safely', async () => {
    const summary: SessionSummary = {
      id: 'session_actions',
      profileName: 'prompt-maker',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
      turnCount: 2,
      preview: 'Original prompt',
    };
    let current = summary;
    let deleted = false;
    const client: ApiClient = {
      baseUrl: '',
      request: async (method, path, body) => {
        if (method === 'GET' && path === '/v1/profiles') return { profiles: [profile] } as never;
        if (method === 'GET' && path === '/v1/models') return { default: {}, options: [] } as never;
        if (method === 'GET' && path === '/v1/profiles/prompt-maker') return { profile } as never;
        if (method === 'GET' && path === '/v1/skills?profile=prompt-maker') return { skills: [] } as never;
        if (method === 'GET' && path === '/v1/sessions?limit=100&profile=prompt-maker&archived=false') {
          return { sessions: deleted ? [] : [current] } as never;
        }
        if (method === 'GET' && path === '/v1/sessions/session_actions') {
          return {
            session: {
              ...current,
              turns: [
                { role: 'user', content: 'Original prompt', timestamp: current.createdAt },
                { role: 'assistant', content: 'Original answer', timestamp: current.updatedAt },
              ],
            },
          } as never;
        }
        if (method === 'GET' && path === '/v1/runs') return { runs: [] } as never;
        if (method === 'PATCH' && path === '/v1/sessions/session_actions') {
          current = { ...current, ...(body as Partial<SessionSummary>) };
          return { session: { ...current, turns: [] } } as never;
        }
        if (method === 'DELETE' && path === '/v1/sessions/session_actions') {
          deleted = true;
          return { deleted: true } as never;
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      stream: async () => new Response(),
      blob: async () => undefined,
    };
    const navigate = vi.fn();
    const { result } = renderHook(() => useAgentController({
      client,
      route: { view: 'agent', profile: 'prompt-maker', session: 'session_actions' },
      navigate,
      onUnauthorized: vi.fn(),
    }));

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    let rename!: Promise<boolean>;
    act(() => { rename = result.current.renameSession('session_actions', 'Renamed session'); });
    expect(await rename).toBe(true);
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('Renamed session'));

    let pin!: Promise<boolean>;
    act(() => { pin = result.current.setSessionPinned('session_actions', true); });
    expect(await pin).toBe(true);
    await waitFor(() => expect(result.current.sessions[0]?.pinned).toBe(true));

    let remove!: Promise<boolean>;
    act(() => { remove = result.current.deleteSession('session_actions'); });
    expect(await remove).toBe(true);
    await waitFor(() => expect(result.current.sessions).toEqual([]));
    expect(result.current.sessionId).toBeUndefined();
    expect(result.current.thread.items).toEqual([]);
    expect(navigate).toHaveBeenLastCalledWith({ view: 'agent', profile: 'prompt-maker' });
  });

  it('replaces a durable exchange without dropping later turns', async () => {
    const summary: SessionSummary = {
      id: 'session_edit',
      profileName: 'prompt-maker',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:06.000Z',
      turnCount: 6,
      preview: 'Conversation 1',
    };
    const run: RunRecord = {
      id: 'run_edit',
      objective: 'Updated conversation 2',
      profile: 'prompt-maker',
      sessionId: 'session_edit',
      status: 'running',
      createdAt: '2026-07-22T00:01:00.000Z',
      eventCount: 0,
      pendingApprovals: [],
    };
    let edited = false;
    const client: ApiClient = {
      baseUrl: '',
      request: async (method, path, body) => {
        if (method === 'GET' && path === '/v1/profiles') return { profiles: [profile] } as never;
        if (method === 'GET' && path === '/v1/models') return { default: {}, options: [] } as never;
        if (method === 'GET' && path === '/v1/profiles/prompt-maker') return { profile } as never;
        if (method === 'GET' && path === '/v1/skills?profile=prompt-maker') return { skills: [] } as never;
        if (method === 'GET' && path === '/v1/sessions?limit=100&profile=prompt-maker&archived=false') {
          return { sessions: [summary] } as never;
        }
        if (method === 'GET' && path === '/v1/sessions/session_edit') {
          return {
            session: {
              ...summary,
              turns: [
                { role: 'user', content: 'Conversation 1', timestamp: '2026-07-22T00:00:00.000Z' },
                { role: 'assistant', content: 'Answer 1', timestamp: '2026-07-22T00:00:01.000Z' },
                {
                  role: 'user',
                  content: edited ? 'Updated conversation 2' : 'Conversation 2',
                  timestamp: '2026-07-22T00:00:02.000Z',
                  attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAA' }],
                },
                {
                  role: 'assistant',
                  content: edited ? 'Updated answer 2' : 'Answer 2',
                  timestamp: '2026-07-22T00:00:03.000Z',
                },
                { role: 'user', content: 'Conversation 3', timestamp: '2026-07-22T00:00:04.000Z' },
                { role: 'assistant', content: 'Answer 3', timestamp: '2026-07-22T00:00:05.000Z' },
              ],
            },
          } as never;
        }
        if (method === 'GET' && path === '/v1/runs') return { runs: [] } as never;
        if (method === 'POST' && path === '/v1/runs') {
          expect(body).toMatchObject({
            objective: 'Updated conversation 2',
            sessionId: 'session_edit',
            replaceUserTurnIndex: 1,
            images: [{ data: 'AAA', mediaType: 'image/png' }],
          });
          return { run } as never;
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      stream: async path => {
        expect(path).toBe('/v1/runs/run_edit/events');
        edited = true;
        const done = { type: 'done', taskId: 'task_edit', status: 'completed' };
        return new Response(`id: 1\nevent: done\ndata: ${JSON.stringify(done)}\n\n`, { status: 200 });
      },
      blob: async () => undefined,
    };

    const { result } = renderHook(() => useAgentController({
      client,
      route: { view: 'agent', profile: 'prompt-maker', session: 'session_edit' },
      navigate: vi.fn(),
      onUnauthorized: vi.fn(),
    }));
    await waitFor(() => expect(result.current.thread.items).toHaveLength(6));
    const target = result.current.thread.items.find(
      item => item.kind === 'user' && item.text === 'Conversation 2',
    );
    if (!target) throw new Error('missing editable turn');

    let replacement!: Promise<boolean>;
    act(() => { replacement = result.current.resendEdited(target.id, 'Updated conversation 2'); });
    const replaced = await replacement;

    expect(replaced).toBe(true);
    await waitFor(() => {
      const userTexts = result.current.thread.items.flatMap(item => item.kind === 'user' ? [item.text] : []);
      expect(userTexts).toEqual(['Conversation 1', 'Updated conversation 2', 'Conversation 3']);
      const assistantTexts = result.current.thread.items.flatMap(
        item => item.kind === 'assistant' ? [item.markdown] : [],
      );
      expect(assistantTexts).toEqual(['Answer 1', 'Updated answer 2', 'Answer 3']);
    });
  });
});
