import type { FastifyInstance } from 'fastify';
import { MarifoldError, type MarifoldRuntime, type ProjectDetail } from '@marifold/core';
import { objectBody, optionalStringField, parseBooleanQuery, parseLimitQuery, requiredString, stringArray } from './Validation';

/**
 * Projects (docs/projects.md): create, edit and delete them, manage the roster,
 * list a project's sessions, and move a session in or out. Who answers inside a
 * project session is decided when a run starts (`planProjectTurn`).
 */
export function registerProjectRoutes(server: FastifyInstance, runtime: MarifoldRuntime, defaultProfile: () => string): void {
  const projects = runtime.projects;
  const existing = (id: string): ProjectDetail => {
    const project = projects.get(id);
    if (!project) { throw MarifoldError.projectNotFound(id); }
    return project;
  };

  server.get('/v1/projects', async () => ({ ok: true, projects: projects.list() }));

  server.post('/v1/projects', async (request, reply) => {
    const body = objectBody(request.body);
    const project = projects.create({
      name: requiredString(body.name, 'name'),
      lead: body.lead === undefined ? defaultProfile() : requiredString(body.lead, 'lead'),
      ...(body.members !== undefined ? { members: stringArray(body.members, 'members') } : {}),
      ...optionalStringField('description', body.description),
      ...optionalStringField('instructions', body.instructions),
    });
    reply.status(201);
    return { ok: true, project };
  });

  server.get<{ Params: { id: string } }>('/v1/projects/:id', async request => ({ ok: true, project: existing(request.params.id) }));

  server.patch<{ Params: { id: string } }>('/v1/projects/:id', async request => {
    const body = objectBody(request.body);
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw MarifoldError.configInvalid('description must be a string or null.');
    }
    return {
      ok: true,
      project: projects.update(request.params.id, {
        ...optionalStringField('name', body.name),
        ...(body.description !== undefined ? { description: body.description as string | null } : {}),
        ...optionalStringField('instructions', body.instructions),
        ...optionalStringField('lead', body.lead),
      }),
    };
  });

  // Its sessions are kept, as ordinary sessions of the profile each started with.
  server.delete<{ Params: { id: string } }>('/v1/projects/:id', async request => ({ ok: true, ...projects.delete(request.params.id) }));

  server.post<{ Params: { id: string } }>('/v1/projects/:id/members', async request => ({
    ok: true,
    project: projects.invite(request.params.id, requiredString(objectBody(request.body).profile, 'profile')),
  }));

  server.delete<{ Params: { id: string; profile: string } }>('/v1/projects/:id/members/:profile', async request => ({
    ok: true,
    project: projects.dismiss(request.params.id, request.params.profile),
  }));

  server.get<{ Params: { id: string }; Querystring: { limit?: string; archived?: string; q?: string } }>('/v1/projects/:id/sessions', async request => {
    existing(request.params.id);
    return {
      ok: true,
      sessions: runtime.listSessions(parseLimitQuery(request.query.limit) ?? 50, undefined, {
        projectId: request.params.id,
        archived: parseBooleanQuery(request.query.archived),
        ...(request.query.q?.trim() ? { search: request.query.q } : {}),
        ...(request.sessionOwner ? { sessionOwner: request.sessionOwner } : {}),
      }),
    };
  });

  // Move to project…: `projectId` moves the session in, `null` moves it out.
  server.post<{ Params: { id: string } }>('/v1/sessions/:id/project', async request => {
    const { projectId } = objectBody(request.body);
    if (projectId !== null && typeof projectId !== 'string') { throw MarifoldError.configInvalid('projectId must be a project id or null.'); }
    return { ok: true, project: projects.moveSession(request.params.id, projectId) ?? null };
  });
}
