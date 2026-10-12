import type { FastifyInstance } from 'fastify';
import { MarifoldError, type MarifoldRuntime } from '@marifold/core';
import { objectBody } from './Validation';

/**
 * The agent computer belongs to this device. These routes are never forwarded
 * through a workspace bridge (`workspaceApiPath` does not list them).
 */
export function registerAgentComputerRoutes(server: FastifyInstance, runtime: MarifoldRuntime): void {
  const computer = runtime.agentComputer;
  const profileNames = () => runtime.listProfiles().map(profile => profile.name);
  const requireProfile = (name: string) => {
    if (!profileNames().includes(name)) { throw MarifoldError.configInvalid(`Unknown profile "${name}".`); }
    return name;
  };

  server.get('/v1/agent-computer', async () => ({ ok: true, ...(await computer.status(profileNames())) }));

  server.put('/v1/agent-computer/settings', async (request) => {
    const body = objectBody(request.body);
    const text = (key: string) => {
      const value = body[key];
      if (value !== undefined && value !== null && typeof value !== 'string') { throw MarifoldError.configInvalid(`${key} must be a string.`); }
      return typeof value === 'string' ? value : undefined;
    };
    return { ok: true, settings: await computer.updateSettings({ proxy: text('proxy'), baseImage: text('baseImage') }) };
  });

  // Creating builds an image on first use, which takes minutes: start it and
  // let the client follow progress through GET /v1/agent-computer.
  server.post<{ Params: { profile: string } }>('/v1/agent-computer/computers/:profile', async (request, reply) => {
    const profile = requireProfile(request.params.profile);
    const rebuildImage = objectBody(request.body ?? {}).rebuildImage === true;
    if (!(await computer.dockerEnvironment()).available) { throw MarifoldError.configInvalid((await computer.dockerEnvironment()).error ?? 'Docker is unavailable.'); }
    computer.create(profile, { rebuildImage }).catch(() => undefined);
    reply.status(202);
    return { ok: true, profile, state: 'creating' };
  });

  server.delete<{ Params: { profile: string } }>('/v1/agent-computer/computers/:profile', async (request) => {
    await computer.remove(request.params.profile);
    return { ok: true };
  });

  server.delete('/v1/agent-computer', async () => {
    await computer.removeAll();
    return { ok: true };
  });
}
