import type { ApiClient } from './client';

/** How often an open session renews its lease. Leases last 60 seconds, so a few missed renewals are tolerated. */
export const SESSION_LEASE_RENEW_MS = 15_000;

function leasePath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/lease`;
}

/** Hold or renew this client's lease on a session; throws SESSION_BUSY while another client holds it. */
export async function acquireSessionLease(client: ApiClient, sessionId: string): Promise<void> {
  await client.request('POST', leasePath(sessionId));
}

/** Move the session's lease to this client, ending the other holder's lease. */
export async function takeOverSessionLease(client: ApiClient, sessionId: string): Promise<void> {
  await client.request('POST', leasePath(sessionId), { takeover: true });
}

/** Release this client's lease so another page or terminal can open the session. */
export async function releaseSessionLease(client: ApiClient, sessionId: string): Promise<void> {
  await client.request('DELETE', leasePath(sessionId));
}

/** True when the error says another client holds the session. Duck-typed so it
 * also matches the in-process runtime's errors, not only MarifoldApiError. */
export function isSessionBusy(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'SESSION_BUSY';
}

export interface SessionLeaseRenewal {
  /** Renew now, e.g. when a page becomes visible again. No-op once stopped or lost. */
  renew(): void;
  /** Stop renewing. Releasing the lease stays with the caller. */
  stop(): void;
}

/**
 * Renew a session lease on an interval. Only losing the session to another
 * client (SESSION_BUSY) ends the renewal and calls `onLost`; a network blip
 * or service restart retries on the next renewal, and the service keeps a
 * running task's session reserved meanwhile.
 */
export function renewSessionLease(options: {
  acquire: () => void | Promise<void>;
  onLost: (error: unknown) => void;
  /** Renew once right away instead of waiting a full interval. */
  immediate?: boolean;
}): SessionLeaseRenewal {
  let stopped = false;
  const renew = async (): Promise<void> => {
    try { await options.acquire(); }
    catch (error) {
      if (stopped || !isSessionBusy(error)) { return; }
      stop();
      options.onLost(error);
    }
  };
  const timer = setInterval(() => { if (!stopped) { void renew(); } }, SESSION_LEASE_RENEW_MS);
  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  if (options.immediate) { void renew(); }
  return {
    renew: () => { if (!stopped) { void renew(); } },
    stop,
  };
}
