const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export interface TransientFetchRetryOptions {
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
}

/** Retry fetch rejections caused by transient network failures. HTTP responses
 * are returned untouched: callers decide whether an application-level request
 * is safe to repeat. */
export async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: TransientFetchRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (attempt >= attempts || init?.signal?.aborted || !isTransientFetchError(error)) throw error;
      await delay(delayMs * attempt);
    }
  }
}

export function isTransientFetchError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}
