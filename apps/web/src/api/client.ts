import type { ApiErrorBody } from './types';

export interface ApiClientOptions {
  /** '' = same-origin (the service hosting the built app). */
  baseUrl?: string;
  token?: string;
}

export interface StreamInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Open an SSE response; the caller consumes `response.body` via parseSse. */
  stream(path: string, init?: StreamInit): Promise<Response>;
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

export function defaultBaseUrl(): string {
  const configured = import.meta.env?.VITE_MARIFOLD_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  // Vite dev server → talk to the default local service; served build → same-origin.
  return import.meta.env?.DEV ? 'http://127.0.0.1:32140' : '';
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  const token = options.token;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await parseJson(response);
    if (!response.ok || (isEnvelope(payload) && payload.ok === false)) {
      throw toApiError(response.status, payload);
    }
    return payload as T;
  }

  async function stream(path: string, init: StreamInit = {}): Promise<Response> {
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
      throw new MarifoldApiError(response.status, { code: 'NO_STREAM_BODY', message: 'The stream response has no body.' });
    }
    return response;
  }

  return { baseUrl, request, stream };
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
