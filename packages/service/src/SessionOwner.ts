import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WorkspaceRequestContext } from './WorkspaceRequestContext';

/** Clients name their app (`web`, `terminal`, …) in this header. */
export const SESSION_APP_HEADER = 'x-marifold-session-owner';
const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

declare module 'fastify' {
  interface FastifyRequest {
    /** Lease owner derived for this request; see `sessionOwnerFor`. */
    sessionOwner?: string;
  }
}

/** The app name a client sent, if it is a valid one. */
export function sessionApp(request: FastifyRequest): string | undefined {
  const app = request.headers[SESSION_APP_HEADER];
  return typeof app === 'string' && APP_NAME.test(app) ? app : undefined;
}

/**
 * A session belongs to one app of one service. Every browser and tab on this
 * service's Web UI, on this machine or reaching it over the network, shares
 * its Web owner, and its terminals share theirs; another app, or another
 * workspace device going through the bridge, sees the session as in use. The
 * client names only its app; the device comes from bridge-authenticated
 * provenance, so a paired device cannot pose as this service's own clients.
 */
export function registerSessionOwners(server: FastifyInstance, workspaceContext: WorkspaceRequestContext): void {
  server.decorateRequest('sessionOwner', undefined);
  server.addHook('onRequest', async request => {
    const app = sessionApp(request);
    if (!app) { return; }
    let provenance;
    try { provenance = workspaceContext.resolve(request.headers); } catch { return; }
    const device = provenance && provenance.senderDeviceId !== provenance.hostDeviceId ? `device-${provenance.senderDeviceId}` : 'local';
    request.sessionOwner = `${device}.${app}`;
  });
}
