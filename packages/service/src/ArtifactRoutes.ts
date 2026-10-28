import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import { ARTIFACT_LIMITS, type ArtifactLibrary, type ArtifactListFilter, formatAssetBytes, MarifoldError, type RunRegistry } from '@marifold/core';
import type { ArtifactViews } from './ArtifactViews';
import type { RunOutput } from './ProjectAssetRoutes';
import { objectBody, optionalStringField, requiredString } from './Validation';

const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const POSITIVE = /^[1-9]\d{0,8}$/;

/**
 * The artifact library (docs/artifacts.md#api): artifacts with their versions,
 * Recently deleted, folders, Save as artifact from a run output, and view
 * tickets for the viewer. Bundles are only ever shown through a view ticket,
 * sandboxed; these routes never serve a bundle's content on this origin.
 */
export function registerArtifactRoutes(server: FastifyInstance, library: ArtifactLibrary, views: ArtifactViews, runs: RunRegistry, runOutput: (runId: string, artifactId: string) => RunOutput): void {
  const sweep = () => { try { library.purgeExpired(); } catch { /* retried next sweep */ } };
  sweep();
  const timer = setInterval(sweep, RETENTION_SWEEP_MS);
  timer.unref();
  server.addHook('onClose', async () => { clearInterval(timer); library.close(); });

  server.get<{ Querystring: Record<string, string | undefined> }>('/v1/artifacts', async request => {
    const query = request.query;
    const filter: ArtifactListFilter = {
      ...(query.folder === 'unfiled' ? { folderId: null } : query.folder ? { folderId: query.folder } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.q ? { query: query.q } : {}),
      ...(query.unread === 'true' ? { unread: true } : {}),
      ...(query.deleted === 'true' ? { deleted: true } : {}),
      ...(query.limit !== undefined ? { limit: positive(query.limit, 'limit') } : {}),
      ...(query.offset !== undefined && query.offset !== '0' ? { offset: positive(query.offset, 'offset') } : {}),
    };
    return { ok: true, artifacts: library.list(filter), usage: library.usage() };
  });

  // Save as artifact: one .html or .md run output, by the profile whose run made it.
  server.post('/v1/artifacts', async (request, reply) => {
    const body = objectBody(request.body);
    const runId = requiredString(body.runId, 'runId');
    const outputId = requiredString(body.artifactId, 'artifactId');
    // Saving the same output again opens what it made rather than copying it.
    const existing = library.savedFromOutput(runId, outputId);
    if (existing) { return { ok: true, artifact: existing }; }
    const output = runOutput(runId, outputId);
    if (output.size > ARTIFACT_LIMITS.versionBytes) {
      throw MarifoldError.artifactLimit(`An artifact is at most ${formatAssetBytes(ARTIFACT_LIMITS.versionBytes)}; this file is ${formatAssetBytes(output.size)}.`);
    }
    let data: Buffer;
    try {
      data = await output.read();
    } catch {
      throw MarifoldError.artifactInvalid(`${output.name} is no longer available: run outputs are kept for a day, and on a device only while it is online.`);
    }
    const same = library.savedFromOutput(runId, outputId, data);
    if (same) { return { ok: true, artifact: same }; }
    const name = path.posix.basename(output.name);
    const run = runs.get(runId);
    const artifact = library.create({
      title: body.title === undefined ? name.replace(/\.[^.]+$/, '') || name : requiredString(body.title, 'title'),
      files: [{ path: name, data }],
      profile: output.profile,
      runId,
      sourceOutput: outputId,
      ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run?.projectTurn ? { projectId: run.projectTurn.projectId } : {}),
      ...optionalFolder(body.folderId),
    });
    reply.status(201);
    return { ok: true, artifact };
  });

  server.get<{ Params: { id: string } }>('/v1/artifacts/:id', async request => ({ ok: true, artifact: requireArtifact(library, request.params.id) }));

  server.patch<{ Params: { id: string } }>('/v1/artifacts/:id', async request => {
    const body = objectBody(request.body);
    if (body.seen !== undefined && typeof body.seen !== 'boolean') { throw MarifoldError.artifactInvalid('seen must be a boolean.'); }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw MarifoldError.artifactInvalid('description must be a string or null.');
    }
    const artifact = library.update(request.params.id, {
      ...optionalStringField('title', body.title),
      ...(body.description !== undefined ? { description: (body.description as string | null) ?? '' } : {}),
      ...(body.folderId !== undefined ? { folderId: body.folderId === null ? null : requiredString(body.folderId, 'folderId') } : {}),
      ...(typeof body.seen === 'boolean' ? { seen: body.seen } : {}),
    });
    return { ok: true, artifact };
  });

  server.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/v1/artifacts/:id', async request => {
    if (request.query.permanent === 'true') { library.purge(request.params.id); } else { library.delete(request.params.id); }
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/v1/artifacts/:id/undelete', async request => ({ ok: true, artifact: library.undelete(request.params.id) }));

  server.post<{ Params: { id: string } }>('/v1/artifacts/:id/restore', async request => {
    const body = objectBody(request.body);
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) { throw MarifoldError.artifactInvalid('version must be a positive whole number.'); }
    return { ok: true, artifact: library.restore(request.params.id, body.version) };
  });

  // A view ticket for one version (the current one by default). Opening the
  // current version marks the artifact read.
  server.post<{ Params: { id: string } }>('/v1/artifacts/:id/view', async request => {
    const body = request.body === undefined || request.body === null ? {} : objectBody(request.body);
    const artifact = requireArtifact(library, request.params.id);
    const version = body.version === undefined ? artifact.currentVersion : body.version;
    const entry = artifact.versions.find(item => item.version === version);
    if (!entry) { throw MarifoldError.artifactInvalid(`${artifact.title} has versions ${artifact.versions.map(item => item.version).join(', ')}.`); }
    if (version === artifact.currentVersion && !artifact.seen && !artifact.deletedAt) { library.update(artifact.id, { seen: true }); }
    const view = views.issue(artifact.id, entry.version);
    return { ok: true, ...view, version: entry.version, entry: entry.entry, kind: artifact.kind, entryPath: `${view.path}${entry.entry.split('/').map(encodeURIComponent).join('/')}` };
  });

  server.get('/v1/artifact-folders', async () => ({
    ok: true,
    folders: library.folders(),
    counts: library.counts(),
  }));

  server.post('/v1/artifact-folders', async (request, reply) => {
    const body = objectBody(request.body);
    reply.status(201);
    return { ok: true, folder: library.createFolder(requiredString(body.name, 'name')) };
  });

  server.patch<{ Params: { id: string } }>('/v1/artifact-folders/:id', async request => {
    const body = objectBody(request.body);
    if (body.sortOrder !== undefined && typeof body.sortOrder !== 'number') { throw MarifoldError.artifactInvalid('sortOrder must be a number.'); }
    if (body.keepLatest !== undefined && body.keepLatest !== null && typeof body.keepLatest !== 'number') { throw MarifoldError.artifactInvalid('keepLatest must be a number or null.'); }
    return {
      ok: true,
      folder: library.updateFolder(request.params.id, {
        ...optionalStringField('name', body.name),
        ...(typeof body.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
        ...(body.keepLatest !== undefined ? { keepLatest: body.keepLatest as number | null } : {}),
      }),
    };
  });

  server.delete<{ Params: { id: string } }>('/v1/artifact-folders/:id', async request => {
    library.deleteFolder(request.params.id);
    return { ok: true };
  });
}

function requireArtifact(library: ArtifactLibrary, id: string) {
  const artifact = library.get(id);
  if (!artifact) { throw MarifoldError.libraryArtifactNotFound(id); }
  return artifact;
}

function optionalFolder(value: unknown): { folderId?: string } {
  return value === undefined || value === null ? {} : { folderId: requiredString(value, 'folderId') };
}

function positive(value: string, label: string): number {
  if (!POSITIVE.test(value)) { throw MarifoldError.artifactInvalid(`${label} must be a positive whole number.`); }
  return Number(value);
}
