import { describe, expect, it, vi } from 'vitest';
import { fetchWithTransientRetry, isTransientFetchError } from '../src/util/fetchRetry';

function networkError(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

describe('fetchWithTransientRetry', () => {
  it('retries a transient connection reset', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce(response);

    await expect(fetchWithTransientRetry('https://example.test', undefined, {
      attempts: 3,
      delayMs: 0,
      fetchImpl,
    })).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient failures', async () => {
    const error = networkError('CERT_HAS_EXPIRED');
    const fetchImpl = vi.fn().mockRejectedValue(error);

    await expect(fetchWithTransientRetry('https://example.test', undefined, {
      attempts: 3,
      delayMs: 0,
      fetchImpl,
    })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP failures without retrying them', async () => {
    const response = new Response('unavailable', { status: 503 });
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await expect(fetchWithTransientRetry('https://example.test', undefined, {
      attempts: 3,
      delayMs: 0,
      fetchImpl,
    })).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured transient-failure attempt limit', async () => {
    const error = networkError('ECONNRESET');
    const fetchImpl = vi.fn().mockRejectedValue(error);

    await expect(fetchWithTransientRetry('https://example.test', undefined, {
      attempts: 3,
      delayMs: 0,
      fetchImpl,
    })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('isTransientFetchError', () => {
  it('finds an undici network code through nested causes', () => {
    expect(isTransientFetchError(networkError('UND_ERR_SOCKET'))).toBe(true);
  });
});
