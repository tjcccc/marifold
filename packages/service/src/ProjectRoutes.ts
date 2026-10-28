import * as fs from 'fs';
import type { FastifyInstance } from 'fastify';
import { type ArtifactLibrary, avatarThumbnail, MarifoldError, type MarifoldRuntime, type ProjectDetail } from '@marifold/core';
import { objectBody, optionalStringField, parseBooleanQuery, parseLimitQuery, requiredString, stringArray } from './Validation';

/**
 * Projects (docs/projects.md): create, edit and delete them, manage the roster,
 * list a project's sessions, and move a session in or out. Assets have their
 * own routes (ProjectAssetRoutes). Who answers inside a
 * project session is decided when a run starts (`planProjectTurn`).
 */
export function registerProjectRoutes(server: FastifyInstance, runtime: MarifoldRuntime, defaultProfile: () => string, artifacts?: ArtifactLibrary): void {
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
    if (body.assetLimitBytes !== undefined && body.assetLimitBytes !== null && typeof body.assetLimitBytes !== 'number') {
      throw MarifoldError.configInvalid('assetLimitBytes must be a number of bytes or null.');
    }
    return {
      ok: true,
      project: projects.update(request.params.id, {
        ...optionalStringField('name', body.name),
        ...(body.description !== undefined ? { description: body.description as string | null } : {}),
        ...optionalStringField('instructions', body.instructions),
        ...optionalStringField('lead', body.lead),
        ...(body.assetLimitBytes !== undefined ? { assetLimitBytes: body.assetLimitBytes as number | null } : {}),
      }),
    };
  });

  // Its sessions are kept, as ordinary sessions of the profile each started with.
  server.delete<{ Params: { id: string } }>('/v1/projects/:id', async request => {
    const result = projects.delete(request.params.id);
    artifacts?.detachProject(request.params.id);
    return { ok: true, ...result };
  });

  // Raw image bytes like profile avatars; clients fetch with auth and show a blob URL.
  server.get<{ Params: { id: string }; Querystring: { thumbnail?: string } }>('/v1/projects/:id/icon', async (request, reply) => {
    if (request.query.thumbnail !== undefined && request.query.thumbnail !== '1') {
      throw MarifoldError.projectInvalid('thumbnail must be 1 when supplied.');
    }
    existing(request.params.id);
    const icon = projects.icon(request.params.id);
    if (!icon) {
      reply.status(404);
      return { ok: false, error: { code: 'ICON_NOT_FOUND', message: `Project '${request.params.id}' has no icon.` } };
    }
    const stat = fs.statSync(icon.path);
    const thumbnail = request.query.thumbnail === '1';
    const etag = `"${Math.round(stat.mtimeMs)}-${stat.size}${thumbnail ? '-thumbnail-v1' : ''}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.status(304);
      return reply.send();
    }
    reply.header('content-type', thumbnail ? 'image/webp' : icon.mediaType);
    reply.header('etag', etag);
    reply.header('cache-control', 'no-cache');
    return reply.send(thumbnail ? await avatarThumbnail(icon.path) : fs.createReadStream(icon.path));
  });

  server.put<{ Params: { id: string } }>('/v1/projects/:id/icon', async request => {
    const body = objectBody(request.body);
    const image = Buffer.from(requiredString(body.data, 'data'), 'base64');
    if (image.length === 0) { throw MarifoldError.configInvalid('data must be non-empty base64.'); }
    return { ok: true, project: projects.setIcon(request.params.id, image, requiredString(body.mediaType, 'mediaType')) };
  });

  server.delete<{ Params: { id: string } }>('/v1/projects/:id/icon', async request => ({ ok: true, ...projects.deleteIcon(request.params.id) }));

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
