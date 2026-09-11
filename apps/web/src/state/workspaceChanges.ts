import { useEffect, useRef } from 'react';
import { MarifoldApiError, type ApiClient } from '../api/client';
const EVENT = 'marifold-workspace-changed';
export function useWorkspaceChangePublisher(client: ApiClient, onAvailability?: (available: boolean) => void): void {
  const availability = useRef(onAvailability);
  availability.current = onAvailability;
  useEffect(() => {
    let live = true;
    let busy = false;
    let revision: string | undefined;
    let interrupted = false;
    const poll = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const result = await client.request<{ revision: string }>('GET', '/v1/changes');
        if (!live || typeof result.revision !== 'string') return;
        availability.current?.(true);
        if (interrupted || (revision !== undefined && revision !== result.revision))
          window.dispatchEvent(new CustomEvent(EVENT, { detail: client.baseUrl }));
        interrupted = false;
        revision = result.revision;
      } catch (error) {
        interrupted = true;
        if (live && (!(error instanceof MarifoldApiError) || error.code === 'WORKSPACE_OFFLINE'))
          availability.current?.(false);
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
