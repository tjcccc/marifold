import * as os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { type DeviceExecution, MarifoldError } from '@marifold/core';
import { objectBody } from './Validation';

/** This device's execution mode for its own Web UI. Turning full access on
 * stays a local command (`marifold execution mode full`), so a page that can
 * reach the API never grants itself account-level commands; turning it off only
 * removes trust. `workspaceApiPath` keeps both routes off the workspace bridge. */
export function registerDeviceExecutionRoutes(server: FastifyInstance, device: DeviceExecution): void {
  const view = () => ({ ok: true, mode: device.mode(), device: os.hostname() });
  server.get('/v1/device-execution', async () => view());
  server.put('/v1/device-execution', async request => {
    if (objectBody(request.body).mode !== 'scoped') {
      throw MarifoldError.configInvalid('Full access can only be turned on locally: run marifold execution mode full on this device.');
    }
    device.setMode('scoped');
    return view();
  });
}
