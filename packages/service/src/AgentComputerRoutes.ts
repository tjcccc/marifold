import type { FastifyInstance } from 'fastify';
import { MarifoldError, type MarifoldRuntime } from '@marifold/core';
import { objectBody } from './Validation';
import type { WorkspaceRequestContext } from './WorkspaceRequestContext';

/**
 * The agent computer belongs to this device. Other devices in its workspace
 * see its status and give or remove a profile's access; creating, rebuilding
 * or removing it, deleting accounts, and its network and image settings stay
 * with this device.
 */
export function registerAgentComputerRoutes(server: FastifyInstance, runtime: MarifoldRuntime, workspaceContext: WorkspaceRequestContext): void {
  const computer = runtime.agentComputer;
  const fromOtherDevice = (headers: Record<string, string | string[] | undefined>) => {
    const provenance = workspaceContext.resolve(headers);
    return provenance !== undefined && provenance.senderDeviceId !== provenance.hostDeviceId;
  };
  server.addHook('onRequest', async (request) => {
    // The matched route, not the raw URL, so no spelling of a path slips past.
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/v1/agent-computer')) { return; }
    const shared = (request.method === 'GET' && route === '/v1/agent-computer')
      || (request.method === 'PUT' && route === '/v1/agent-computer/profiles/:profile');
    if (!shared && fromOtherDevice(request.headers)) {
      throw MarifoldError.hostOnlySetting('The agent computer is managed on the workspace host; other devices can only give or remove profile access.');
    }
  });
  const profileNames = () => runtime.listProfiles().map(profile => profile.name);
  const requireProfile = (name: string) => {
    if (!profileNames().includes(name)) { throw MarifoldError.configInvalid(`Unknown profile "${name}".`); }
    return name;
  };

  server.get('/v1/agent-computer', async (request) => ({ ok: true, ...(await computer.status(profileNames())), managedHere: !fromOtherDevice(request.headers) }));

  server.put('/v1/agent-computer/settings', async (request) => {
    const body = objectBody(request.body);
    const text = (key: string) => {
      const value = body[key];
      if (value !== undefined && value !== null && typeof value !== 'string') { throw MarifoldError.configInvalid(`${key} must be a string.`); }
      return typeof value === 'string' ? value : undefined;
    };
    const proxy = text('proxy');
    const baseImage = text('baseImage');
    return { ok: true, settings: await computer.updateSettings({ ...(proxy !== undefined ? { proxy } : {}), ...(baseImage !== undefined ? { baseImage } : {}) }) };
  });

  // Creating builds an image on first use, which takes minutes: start it and
  // let the client follow progress through GET /v1/agent-computer.
  server.post('/v1/agent-computer/computer', async (request, reply) => {
    const rebuildImage = objectBody(request.body ?? {}).rebuildImage === true;
    const docker = await computer.dockerEnvironment();
    if (!docker.available) { throw MarifoldError.configInvalid(docker.error ?? 'Docker is unavailable.'); }
    computer.create({ rebuildImage }).catch(() => undefined);
    reply.status(202);
    return { ok: true, state: 'creating' };
  });

  server.delete('/v1/agent-computer/computer', async () => {
    await computer.remove();
    return { ok: true };
  });

  // access: true creates the profile's account when it has none; false keeps it.
  server.put<{ Params: { profile: string } }>('/v1/agent-computer/profiles/:profile', async (request) => {
    const profile = requireProfile(request.params.profile);
    const access = objectBody(request.body).access;
    if (typeof access !== 'boolean') { throw MarifoldError.configInvalid('access must be a boolean.'); }
    if (access) {
      await computer.giveAccess(profile);
    } else {
      computer.removeAccess(profile);
    }
    return { ok: true, profile, access };
  });

  server.delete<{ Params: { profile: string } }>('/v1/agent-computer/profiles/:profile', async (request) => {
    await computer.removeAccount(request.params.profile);
    return { ok: true };
  });

  server.delete('/v1/agent-computer', async () => {
    await computer.removeAll();
    return { ok: true };
  });
}
