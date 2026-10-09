import { afterEach, expect, it, vi } from 'vitest';
import { renewSessionLease, SESSION_LEASE_RENEW_MS } from '../src';

afterEach(() => {
  vi.useRealTimers();
});

const busy = Object.assign(new Error('in use elsewhere'), { code: 'SESSION_BUSY' });

it('keeps renewing through transient failures and stops once another client holds the session', async () => {
  vi.useFakeTimers();
  const outcomes: Array<Error | undefined> = [new Error('network down'), undefined, busy];
  const acquire = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (outcome) { throw outcome; }
  });
  const onLost = vi.fn();
  renewSessionLease({ acquire, onLost });

  await vi.advanceTimersByTimeAsync(SESSION_LEASE_RENEW_MS * 2);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(onLost).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(SESSION_LEASE_RENEW_MS * 3);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(onLost).toHaveBeenCalledExactlyOnceWith(busy);
});

it('treats a synchronous busy throw from the in-process runtime as a lost session', async () => {
  vi.useFakeTimers();
  const onLost = vi.fn();
  const lease = renewSessionLease({ acquire: () => { throw busy; }, onLost, immediate: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(onLost).toHaveBeenCalledExactlyOnceWith(busy);
  lease.renew();
  await vi.advanceTimersByTimeAsync(SESSION_LEASE_RENEW_MS);
  expect(onLost).toHaveBeenCalledTimes(1);
});
