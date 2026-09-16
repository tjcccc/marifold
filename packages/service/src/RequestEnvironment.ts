import { networkInterfaces } from 'node:os';
import type { FastifyRequest } from 'fastify';
import { parseClientEnvironment, type RuntimeEnvironment } from '@marifold/core';
import type { WorkspaceRequestProvenance } from './WorkspaceRequestContext';

export function requestOrigin(request: FastifyRequest, provenance?: WorkspaceRequestProvenance): 'local' | 'remote' {
  if (provenance?.remoteRequest || (provenance && provenance.senderDeviceId !== provenance.hostDeviceId)) return 'remote';
  const ip = request.ip.toLowerCase().replace(/^::ffff:/, '');
  const local = ip === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip)
    || Object.values(networkInterfaces()).some(entries => entries?.some(entry => entry.address.toLowerCase() === ip));
  return local ? 'local' : 'remote';
}

export function requestEnvironment(request: FastifyRequest, provenance?: WorkspaceRequestProvenance): RuntimeEnvironment {
  const value = (request.body as { environment?: unknown } | undefined)?.environment;
  return { ...parseClientEnvironment(value), request: requestOrigin(request, provenance) };
}
