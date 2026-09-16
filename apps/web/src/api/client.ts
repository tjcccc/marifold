import { createApiClient as createTransport, type ApiClientOptions } from '@marifold/client';
export { MarifoldApiError } from '@marifold/client';
export type { ApiClient, ApiClientOptions, StreamInit } from '@marifold/client';
export function defaultBaseUrl(): string {
  const configured = import.meta.env?.VITE_MARIFOLD_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return import.meta.env?.DEV ? 'http://127.0.0.1:32140' : '';
}
export function createApiClient(options: ApiClientOptions = {}) {
  return createTransport({ interface: 'web', ...options, baseUrl: options.baseUrl ?? defaultBaseUrl() });
}
