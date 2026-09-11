import type { FastifyInstance } from 'fastify';
import type { MarifoldRuntime } from '@marifold/core';
import { objectBody, optionalBooleanField, optionalStringField, requiredString } from './Validation';

/** Schedule configuration is shared; scheduled execution always stays on the host. */
export function registerWorkspaceScheduleRoutes(server: FastifyInstance, runtime: MarifoldRuntime): void {
  server.post('/v1/schedules', async (request) => {
    const body = objectBody(request.body);
    return {
      ok: true,
      schedule: runtime.createSchedule({
        name: requiredString(body.name, 'name'),
        objective: requiredString(body.objective, 'objective'),
        cron: requiredString(body.cron, 'cron'),
        ...optionalStringField('profile', body.profile),
        ...optionalBooleanField('enabled', body.enabled),
      }),
    };
  });
  server.patch<{ Params: { id: string } }>('/v1/schedules/:id', async (request) => {
    const body = objectBody(request.body);
    return {
      ok: true,
      schedule: runtime.updateSchedule(request.params.id, {
        ...optionalStringField('name', body.name),
        ...optionalStringField('objective', body.objective),
        ...optionalStringField('cron', body.cron),
        ...optionalStringField('profile', body.profile),
        ...optionalBooleanField('enabled', body.enabled),
      }),
    };
  });
  server.delete<{ Params: { id: string } }>('/v1/schedules/:id', async (request) => ({
    ok: true,
    deleted: runtime.deleteSchedule(request.params.id),
  }));
  server.post<{ Params: { id: string } }>('/v1/schedules/:id/run', async (request) => ({
    ok: true,
    ...(await runtime.runScheduleUnattended(request.params.id)),
  }));
}
