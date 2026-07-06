import * as fs from 'fs';
import { FastifyInstance } from 'fastify';
import {
  ApprovalMode,
  MarifoldError,
  MarifoldRuntime,
  ProfileFileKind,
  ToolKind,
} from '@marifold/core';
import { objectBody, requiredString, stringValue } from './Validation';

const TOOL_KINDS: ToolKind[] = ['read', 'write', 'shell', 'network', 'delegate'];
const APPROVAL_MODES: ApprovalMode[] = ['allow', 'ask', 'deny'];
const PROFILE_FILES: ProfileFileKind[] = ['profile', 'rules', 'custom'];

/** Parsed PATCH /v1/profiles/:name body. For every field: absent = untouched,
 * null = clear the override (inherit again). */
interface ProfilePatch {
  mode?: 'agent' | 'chat';
  /** Both strings sets the override; both null clears it. */
  model?: { provider: string; model: string } | null;
  memories?: boolean | null;
  think?: boolean | null;
  maxContextTokens?: number | null;
  sessionContextTurns?: number | 'all' | null;
  approval?: Partial<Record<ToolKind, ApprovalMode | null>>;
}

/**
 * Profile/memory write routes (the Web UI Config editor's surface). All writes
 * go through MarifoldRuntime → ProfileManager/MemoryStore, so validation and
 * profile.toml preservation match the TUI's commands exactly.
 */
export function registerProfileRoutes(server: FastifyInstance, runtime: MarifoldRuntime): void {
  // Scaffold a new profile (same layout as `profile init`); clients follow up
  // with PATCH / avatar PUT for the initial settings.
  server.post('/v1/profiles', async (request, reply) => {
    const body = objectBody(request.body);
    const profile = runtime.initProfile(requiredString(body.name, 'name'));
    reply.status(201);
    return { ok: true, profile };
  });

  // Raw image bytes (not the JSON envelope): <img>-friendly apart from auth —
  // token-bearing clients fetch with headers and render a blob URL.
  server.get<{ Params: { name: string } }>('/v1/profiles/:name/avatar', async (request, reply) => {
    runtime.getProfile(request.params.name);
    const avatar = runtime.getProfileAvatar(request.params.name);
    if (!avatar) {
      reply.status(404);
      return {
        ok: false,
        error: { code: 'AVATAR_NOT_FOUND', message: `Profile '${request.params.name}' has no avatar.` },
      };
    }
    const stat = fs.statSync(avatar.path);
    const etag = `"${Math.round(stat.mtimeMs)}-${stat.size}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.status(304);
      return reply.send();
    }
    reply.header('content-type', avatar.mediaType);
    reply.header('etag', etag);
    reply.header('cache-control', 'no-cache');
    return reply.send(fs.createReadStream(avatar.path));
  });

  server.put<{ Params: { name: string } }>('/v1/profiles/:name/avatar', async request => {
    const name = request.params.name;
    runtime.getProfile(name);
    const body = objectBody(request.body);
    const data = requiredString(body.data, 'data');
    const mediaType = requiredString(body.mediaType, 'mediaType');
    const image = Buffer.from(data, 'base64');
    if (image.length === 0) throw MarifoldError.configInvalid('data must be non-empty base64.');
    runtime.setProfileAvatar(name, image, mediaType);
    return { ok: true, profile: runtime.getProfile(name) };
  });

  server.delete<{ Params: { name: string } }>('/v1/profiles/:name/avatar', async request => {
    const name = request.params.name;
    runtime.getProfile(name);
    const removed = runtime.deleteProfileAvatar(name);
    return { ok: true, removed, profile: runtime.getProfile(name) };
  });

  server.patch<{ Params: { name: string } }>('/v1/profiles/:name', async request => {
    const name = request.params.name;
    runtime.getProfile(name); // throws PROFILE_INVALID (400) for unknown names
    const patch = parseProfilePatch(request.body);

    if (patch.mode !== undefined) runtime.setProfileMode(name, patch.mode);
    if (patch.model !== undefined) {
      if (patch.model === null) runtime.setProfileModelOverride(name, undefined, undefined);
      else runtime.setProfileModelOverride(name, patch.model.provider, patch.model.model);
    }
    if (patch.memories !== undefined) runtime.setProfileMemories(name, patch.memories ?? undefined);
    if (patch.think !== undefined) runtime.setProfileThink(name, patch.think ?? undefined);
    if (patch.maxContextTokens !== undefined) {
      runtime.setProfileMaxContextTokens(name, patch.maxContextTokens ?? undefined);
    }
    if (patch.sessionContextTurns !== undefined) {
      runtime.setProfileSessionContextTurns(name, patch.sessionContextTurns ?? undefined);
    }
    for (const [kind, mode] of Object.entries(patch.approval ?? {})) {
      runtime.setProfileAgentApproval(name, kind as ToolKind, mode ?? undefined);
    }

    return { ok: true, profile: runtime.getProfile(name) };
  });

  server.put<{ Params: { name: string; file: string } }>('/v1/profiles/:name/files/:file', async request => {
    const name = request.params.name;
    runtime.getProfile(name);
    const file = request.params.file as ProfileFileKind;
    if (!PROFILE_FILES.includes(file)) {
      throw MarifoldError.configInvalid(`Unknown profile file '${request.params.file}'. Use profile, rules, or custom.`);
    }
    const body = objectBody(request.body);
    runtime.writeProfileFile(name, file, stringValue(body.content, 'content'));
    return { ok: true, profile: runtime.getProfile(name) };
  });

  server.post<{ Params: { name: string } }>('/v1/profiles/:name/trusted-folders', async request => {
    const name = request.params.name;
    runtime.getProfile(name);
    const body = objectBody(request.body);
    const folder = runtime.addProfileTrustedFolder(name, requiredString(body.folder, 'folder'));
    return { ok: true, folder, profile: runtime.getProfile(name) };
  });

  // Folder in the body, not the path — trusted folders contain slashes.
  server.delete<{ Params: { name: string } }>('/v1/profiles/:name/trusted-folders', async request => {
    const name = request.params.name;
    runtime.getProfile(name);
    const body = objectBody(request.body);
    const removed = runtime.removeProfileTrustedFolder(name, requiredString(body.folder, 'folder'));
    return { ok: true, removed, profile: runtime.getProfile(name) };
  });

  server.delete<{
    Params: { name: string; id: string };
    Querystring: { mode?: string };
  }>('/v1/profiles/:name/memories/:id', async request => {
    const name = request.params.name;
    runtime.getProfile(name); // avoid MemoryStore scaffolding a phantom profile
    const mode = request.query.mode ?? 'forget';
    if (mode !== 'forget' && mode !== 'delete') {
      throw MarifoldError.configInvalid(`mode must be "forget" or "delete", got '${mode}'.`);
    }
    const result = mode === 'delete'
      ? runtime.deleteMemoryById(name, request.params.id)
      : runtime.forgetMemoryById(name, request.params.id);
    return {
      ok: true,
      profile: name,
      mode,
      removed: result.count > 0,
      memories: runtime.listMemories(name, false),
    };
  });
}

function parseProfilePatch(value: unknown): ProfilePatch {
  const body = objectBody(value);
  const patch: ProfilePatch = {};

  if (body.mode !== undefined) {
    const mode = stringValue(body.mode, 'mode');
    if (mode !== 'agent' && mode !== 'chat') {
      throw MarifoldError.configInvalid(`mode must be "agent" or "chat", got '${mode}'.`);
    }
    patch.mode = mode;
  }

  const hasProvider = body.provider !== undefined;
  const hasModel = body.model !== undefined;
  if (hasProvider || hasModel) {
    if (body.provider === null && body.model === null) {
      patch.model = null;
    } else if (hasProvider && hasModel) {
      patch.model = {
        provider: requiredString(body.provider, 'provider'),
        model: requiredString(body.model, 'model'),
      };
    } else {
      throw MarifoldError.configInvalid('Set provider and model together (both strings, or both null to clear).');
    }
  }

  patch.memories = nullableBoolean(body.memories, 'memories');
  patch.think = nullableBoolean(body.think, 'think');

  if (body.maxContextTokens !== undefined) {
    if (body.maxContextTokens === null) patch.maxContextTokens = null;
    else if (typeof body.maxContextTokens === 'number' && Number.isInteger(body.maxContextTokens) && body.maxContextTokens > 0) {
      patch.maxContextTokens = body.maxContextTokens;
    } else {
      throw MarifoldError.configInvalid('maxContextTokens must be a positive integer or null.');
    }
  }

  if (body.sessionContextTurns !== undefined) {
    const turns = body.sessionContextTurns;
    if (turns === null || turns === 'all') patch.sessionContextTurns = turns === null ? null : 'all';
    else if (typeof turns === 'number' && Number.isInteger(turns) && turns >= 0) patch.sessionContextTurns = turns;
    else throw MarifoldError.configInvalid('sessionContextTurns must be a non-negative integer, "all", or null.');
  }

  if (body.approval !== undefined) {
    const approval = objectBody(body.approval);
    patch.approval = {};
    for (const [kind, mode] of Object.entries(approval)) {
      if (!TOOL_KINDS.includes(kind as ToolKind)) {
        throw MarifoldError.configInvalid(`Unknown approval kind '${kind}'. Use ${TOOL_KINDS.join(', ')}.`);
      }
      if (mode !== null && !APPROVAL_MODES.includes(mode as ApprovalMode)) {
        throw MarifoldError.configInvalid(`approval.${kind} must be one of ${APPROVAL_MODES.join(', ')}, or null to inherit.`);
      }
      patch.approval[kind as ToolKind] = mode as ApprovalMode | null;
    }
  }

  // Drop the undefined placeholders so "absent" and "clear" stay distinct.
  if (patch.memories === undefined) delete patch.memories;
  if (patch.think === undefined) delete patch.think;
  return patch;
}

function nullableBoolean(value: unknown, label: string): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  throw MarifoldError.configInvalid(`${label} must be a boolean or null.`);
}
