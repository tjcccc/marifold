import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import { type ArtifactChunk, formatAssetBytes, type LinkDevice, linkLocation, MarifoldError, MAX_ASSET_BYTES, type MarifoldRuntime, parseLinkTarget, type ProjectAsset, type RunRegistry, type WorkspaceManager, workspaceArtifactStream } from '@marifold/core';
import { artifactHeaders } from './ArtifactTickets';
import { objectBody, optionalStringField, requiredString } from './Validation';
import { remoteExecution } from './WorkspaceRoutes';

/** A run output as "Add to assets" reads it: from this device, or over the
 * bridge from the device that ran it. */
export interface RunOutput {
  name: string;
  mediaType: string;
  size: number;
  read(): Promise<Buffer>;
}

/** Run outputs by id, with the same provenance and containment as downloads. */
export function runOutputs(runs: RunRegistry, manager: WorkspaceManager): (runId: string, artifactId: string) => RunOutput {
  return (runId, artifactId) => {
    const artifact = runs.require(runId).artifacts?.find(candidate => candidate.id === artifactId);
    if (!artifact) { throw MarifoldError.artifactNotFound(runId, artifactId); }
    const origin = runs.artifactOrigin(runId, artifactId);
    const execution = remoteExecution(manager, origin.run.execution);
    return {
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: artifact.size,
      read: async () => {
        if (!execution) {
          const fd = fs.openSync(runs.requireArtifact(runId, artifactId).path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            return fs.readFileSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        }
        const parts: Buffer[] = [];
        for await (const part of workspaceArtifactStream(artifact.size, (offset, length) => manager.execute(execution.workspaceId, execution.executionDeviceId, 'executor.artifact', {
          runId: origin.run.id, artifactId: origin.artifactId, offset, length,
        }) as Promise<ArtifactChunk>)) {
          parts.push(part);
        }
        return Buffer.concat(parts);
      },
    };
  };
}

/** The workspace devices a request sees, and the device that sent it (absent: this one). */
export type LinkOrigin = (headers: Record<string, string | string[] | undefined>) => { devices: LinkDevice[]; senderDeviceId?: string };

/**
 * Project assets (docs/projects.md#assets): list, upload, add a run's output,
 * link a file or folder on a device, versions, download, rename or describe,
 * and delete. Content is always served as a download, never rendered on this
 * origin.
 */
export function registerProjectAssetRoutes(server: FastifyInstance, runtime: MarifoldRuntime, runOutput: (runId: string, artifactId: string) => RunOutput, origin: LinkOrigin): void {
  const assets = runtime.projects.assets;
  // Links carry their device's name and whether it can be reached now.
  const located = (asset: ProjectAsset, devices: LinkDevice[]) => {
    if (asset.kind !== 'linked') { return asset; }
    const { deviceName, available } = linkLocation(asset, { devices, delegate: false });
    return { ...asset, ...(deviceName ? { deviceName } : {}), available };
  };
  const listed = (projectId: string, headers: Record<string, string | string[] | undefined>) => {
    const { devices } = origin(headers);
    const { assets: list, usage } = assets.list(projectId);
    return { ok: true, assets: list.map(asset => located(asset, devices)), usage };
  };

  server.get<{ Params: { id: string } }>('/v1/projects/:id/assets', async request => listed(request.params.id, request.headers));

  // `target` is `@device/~/path`, `@device/` and an absolute path, or a bare
  // path on the sending device.
  server.post<{ Params: { id: string } }>('/v1/projects/:id/links', async (request, reply) => {
    const body = objectBody(request.body);
    const { devices, senderDeviceId } = origin(request.headers);
    const target = parseLinkTarget(requiredString(body.target, 'target'), devices, senderDeviceId, request.params.id);
    const asset = assets.link(request.params.id, { ...target, ...optionalStringField('name', body.name), ...optionalStringField('description', body.description) });
    reply.status(201);
    return { ok: true, asset: located(asset, devices) };
  });

  // Base64 JSON like run uploads, so the service's request limit bounds it.
  server.post<{ Params: { id: string } }>('/v1/projects/:id/assets', async (request, reply) => {
    const body = objectBody(request.body);
    const data = Buffer.from(requiredString(body.data, 'data'), 'base64');
    if (data.length === 0) { throw MarifoldError.configInvalid('data must be non-empty base64.'); }
    const saved = assets.save(request.params.id, {
      name: requiredString(body.name, 'name'),
      data,
      mediaType: requiredString(body.mediaType, 'mediaType'),
      ...optionalStringField('description', body.description),
    });
    reply.status(saved.newVersion ? 201 : 200);
    return { ok: true, ...saved };
  });

  server.post<{ Params: { id: string } }>('/v1/projects/:id/assets/from-run', async (request, reply) => {
    const body = objectBody(request.body);
    const runId = requiredString(body.runId, 'runId');
    const output = runOutput(runId, requiredString(body.artifactId, 'artifactId'));
    if (output.size > MAX_ASSET_BYTES) {
      throw MarifoldError.projectAssetLimit(request.params.id, `An asset is at most ${formatAssetBytes(MAX_ASSET_BYTES)}; this file is ${formatAssetBytes(output.size)}.`);
    }
    let data: Buffer;
    try {
      data = await output.read();
    } catch {
      throw MarifoldError.projectInvalid(`${output.name} is no longer available: run outputs are kept for a day, and on a device only while it is online.`, request.params.id);
    }
    const saved = assets.save(request.params.id, {
      name: body.name === undefined ? path.posix.basename(output.name) : requiredString(body.name, 'name'),
      data,
      mediaType: output.mediaType,
      runId,
      ...optionalStringField('description', body.description),
    });
    reply.status(saved.newVersion ? 201 : 200);
    return { ok: true, ...saved };
  });

  server.get<{ Params: { id: string; assetId: string } }>('/v1/projects/:id/assets/:assetId/versions', async request => ({
    ok: true,
    versions: assets.versions(request.params.id, request.params.assetId),
  }));

  server.get<{ Params: { id: string; assetId: string }; Querystring: { version?: string } }>('/v1/projects/:id/assets/:assetId/content', async (request, reply) => {
    const raw = request.query.version;
    if (raw !== undefined && !/^[1-9]\d{0,8}$/.test(raw)) { throw MarifoldError.projectInvalid('version must be a positive whole number.'); }
    const content = assets.content(request.params.id, request.params.assetId, raw === undefined ? undefined : Number(raw));
    artifactHeaders(reply, content);
    return reply.send(fs.createReadStream(content.path));
  });

  server.patch<{ Params: { id: string; assetId: string } }>('/v1/projects/:id/assets/:assetId', async request => {
    const body = objectBody(request.body);
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw MarifoldError.configInvalid('description must be a string or null.');
    }
    const asset = assets.update(request.params.id, request.params.assetId, {
      ...optionalStringField('name', body.name),
      ...(body.description !== undefined ? { description: body.description as string | null } : {}),
    });
    return { ok: true, asset: located(asset, origin(request.headers).devices) };
  });

  server.delete<{ Params: { id: string; assetId: string } }>('/v1/projects/:id/assets/:assetId', async request => {
    assets.delete(request.params.id, request.params.assetId);
    return listed(request.params.id, request.headers);
  });
}
