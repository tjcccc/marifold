import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, MarifoldApiError } from '../../src/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('createApiClient', () => {
  it('joins the base URL and returns the parsed envelope', async () => {
    const mock = stubFetch(new Response(JSON.stringify({ ok: true, runs: [] }), { status: 200 }));
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:32140/' });
    const body = await client.request<{ runs: unknown[] }>('GET', '/v1/runs');
    expect(body.runs).toEqual([]);
    expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:32140/v1/runs');
  });

  it('sends the bearer token and JSON body', async () => {
    const mock = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createApiClient({ baseUrl: 'http://x', token: 'sekret' });
    await client.request('POST', '/v1/runs', { objective: 'hi' });
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sekret');
    expect(init.body).toBe(JSON.stringify({ objective: 'hi' }));
  });

  it('turns the error envelope into a typed MarifoldApiError', async () => {
    stubFetch(new Response(
      JSON.stringify({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run not found: x' } }),
      { status: 404 },
    ));
    const client = createApiClient({ baseUrl: 'http://x' });
    try {
      await client.request('GET', '/v1/runs/x');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MarifoldApiError);
      expect((error as MarifoldApiError).code).toBe('RUN_NOT_FOUND');
      expect((error as MarifoldApiError).status).toBe(404);
    }
  });

  it('falls back to an HTTP_<status> code for non-envelope failures', async () => {
    stubFetch(new Response('gateway exploded', { status: 502 }));
    const client = createApiClient({ baseUrl: 'http://x' });
    await expect(client.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'HTTP_502' });
  });

  it('stream() sends last-event-id and rejects on an error status', async () => {
    const mock = stubFetch(new Response(
      JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'nope' } }),
      { status: 401 },
    ));
    const client = createApiClient({ baseUrl: 'http://x', token: 'bad' });
    await expect(client.stream('/v1/runs/r/events', { lastEventId: '9' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['last-event-id']).toBe('9');
  });
});
