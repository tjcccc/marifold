import { useEffect, useRef } from 'react';
import type { ApiClient } from '../api/client';
const EVENT = 'marifold-workspace-changed';
export function useWorkspaceChangePublisher(client: ApiClient, onAvailability?: (available: boolean) => void): void {
  const availability = useRef(onAvailability);
  availability.current = onAvailability;
  useEffect(() => {
    let live = true;
    let busy = false;
    let revision: string | undefined;
    const poll = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const result = await client.request<{ revision: string }>('GET', '/v1/changes');
        if (!live || typeof result.revision !== 'string') return;
        availability.current?.(true);
        if (revision !== undefined && revision !== result.revision)
          window.dispatchEvent(new CustomEvent(EVENT, { detail: client.baseUrl }));
        revision = result.revision;
      } catch {
        if (live) availability.current?.(false);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client]);
}
export function useWorkspaceChanges(client: ApiClient, changed: () => void): void {
  const callback = useRef(changed);
  callback.current = changed;
  useEffect(() => {
    const handle = (event: Event) => {
      if ((event as CustomEvent).detail === client.baseUrl) callback.current();
    };
    window.addEventListener(EVENT, handle);
    return () => window.removeEventListener(EVENT, handle);
  }, [client]);
}
