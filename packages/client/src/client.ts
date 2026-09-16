export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string>;
}

export interface ApiClientOptions {
  interface?: 'terminal' | 'web' | 'desktop' | 'mobile';
  timezone?: string;
  /** '' = same-origin (the service hosting the built app). */
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
  executionDevice?: () => string | undefined;
}

export interface StreamInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly baseUrl: string;
  /** Connected service origin, before a workspace proxy prefix. */
  readonly serverUrl?: string;
  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Open an SSE response; the caller consumes `response.body` via parseSse. */
  stream(path: string, init?: StreamInit): Promise<Response>;
  /** Fetch binary content with auth (`<img src>` can't send a bearer token).
   * undefined on 404; other failures throw. */
  blob(path: string): Promise<Blob | undefined>;
}

export class MarifoldApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'MarifoldApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const localBase = (options.baseUrl ?? '').replace(/\/$/, '');
  const baseUrl = options.workspaceId
    ? `${localBase}/v1/workspaces/${encodeURIComponent(options.workspaceId)}/api`
    : localBase;
  const token = options.token;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  function withEnvironment(path: string, body: unknown): unknown {
    if (!options.interface || !['/v1/runs', '/v1/ask', '/v1/chat/stream'].includes(path) || !body || typeof body !== 'object') return body;
    return { ...body, environment: { interface: options.interface, timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } };
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (method === 'POST') body = withEnvironment(path, body);
    const run =
      typeof body === 'object' && body !== null
        ? (body as { lean?: boolean; userTurn?: string; objective?: string })
        : undefined;
    const hostSkill = run?.lean || /^\s*\$[\w-]+/.test(run?.userTurn ?? run?.objective ?? '');
    const executionDeviceId = path === '/v1/runs' && !hostSkill ? options.executionDevice?.() : undefined;
    if (executionDeviceId && typeof body === 'object' && body !== null) body = { ...body, executionDeviceId };
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers({
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET'
          ? {
              'idempotency-key': Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
                b.toString(16).padStart(2, '0'),
              ).join(''),
            }
          : {}),
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await parseJson(response);
    if (!response.ok || (isEnvelope(payload) && payload.ok === false)) {
      throw toApiError(response.status, payload);
    }
    return payload as T;
  }

  async function stream(path: string, init: StreamInit = {}): Promise<Response> {
    if (init.method === 'POST') init = { ...init, body: withEnvironment(path, init.body) };
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: headers({
        accept: 'text/event-stream',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.lastEventId !== undefined ? { 'last-event-id': init.lastEventId } : {}),
      }),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal ?? null,
    });
    if (!response.ok) {
      throw toApiError(response.status, await parseJson(response));
    }
    if (!response.body) {
      throw new MarifoldApiError(response.status, {
        code: 'NO_STREAM_BODY',
        message: 'The stream response has no body.',
      });
    }
    return response;
  }

  async function blob(path: string): Promise<Blob | undefined> {
    const response = await fetch(`${baseUrl}${path}`, { headers: headers() });
    if (response.status === 404) return undefined;
    if (!response.ok) throw toApiError(response.status, await parseJson(response));
    return response.blob();
  }

  return { baseUrl, serverUrl: localBase, request, stream, blob };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isEnvelope(value: unknown): value is { ok?: boolean; error?: ApiErrorBody } {
  return typeof value === 'object' && value !== null;
}

function toApiError(status: number, payload: unknown): MarifoldApiError {
  if (isEnvelope(payload) && payload.error && typeof payload.error.code === 'string') {
    return new MarifoldApiError(status, payload.error);
  }
  return new MarifoldApiError(status, {
    code: `HTTP_${status}`,
    message: `Request failed with status ${status}.`,
  });
}
