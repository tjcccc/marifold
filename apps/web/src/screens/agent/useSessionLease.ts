import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { acquireSessionLease, releaseSessionLease, renewSessionLease, takeOverSessionLease } from '../../api/sessions';

/**
 * This page's lease on the open session: renewed on an interval and when the
 * page becomes visible again, released on pagehide and when the session
 * closes. `onLost` runs when another page or device holds the session.
 */
export function useSessionLease(
  client: ApiClient,
  sessionId: string | undefined,
  onLost: (error: unknown, sessionId: string) => void,
): { takeOver: (sessionId: string) => Promise<void> } {
  // Bumping this restarts lease renewal after a takeover.
  const [leaseEpoch, setLeaseEpoch] = useState(0);
  // The renewal that a takeover replaces must not release the lease it just took.
  const keepLeaseRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!sessionId) { return; }
    const id = sessionId;
    // loadSession already acquired the lease, so renewal starts an interval later.
    const lease = renewSessionLease({
      acquire: () => acquireSessionLease(client, id),
      onLost: error => onLost(error, id),
    });
    const release = () => { void releaseSessionLease(client, id).catch(() => undefined); };
    // Background tabs throttle timers below the renewal rate, and a page
    // restored from the back/forward cache released its lease on pagehide.
    // Renew as soon as the page is visible again.
    const resume = () => { if (document.visibilityState === 'visible') { lease.renew(); } };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      lease.stop();
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
      if (keepLeaseRef.current === id) { keepLeaseRef.current = undefined; }
      else { release(); }
    };
  }, [client, sessionId, onLost, leaseEpoch]);

  /** Move the session's lease to this page; renewal restarts without releasing it. */
  const takeOver = useCallback(async (id: string) => {
    await takeOverSessionLease(client, id);
    keepLeaseRef.current = id;
    setLeaseEpoch(epoch => epoch + 1);
  }, [client]);

  return { takeOver };
}
