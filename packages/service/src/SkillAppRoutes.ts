import { FastifyInstance } from 'fastify';
import {
  MarifoldError,
  MarifoldRuntime,
  MarifoldSkill,
  type SkillAppAttachmentInput,
  type SkillAppDefinition,
} from '@marifold/core';
import { JsonObject, objectBody, optionalStringField, requiredString } from './Validation';

/** Skill hints and invocation resolution, and SkillApp definitions and instances. */
export function registerSkillAppRoutes(
  server: FastifyInstance,
  runtime: MarifoldRuntime,
  skillAppInstances: ReturnType<MarifoldRuntime['createSkillAppInstanceRegistry']>,
): void {
  // Available skills (name + usage) for the composer's $-autocomplete,
  // profile-scoped so profile skills shadow global ones.
  server.get<{ Querystring: { profile?: string } }>('/v1/skills', async request => ({
    ok: true,
    skills: runtime.listSkills(request.query.profile).map(skillHint),
  }));

  // Resolve a `$skill [args]` invocation in code so Web/service clients do not
  // spend an agent loop searching the filesystem for a skill already indexed
  // by Marifold.
  server.post('/v1/skills/resolve', async request => {
    const body = objectBody(request.body);
    const profile = optionalStringField('profile', body.profile).profile;
    return {
      ok: true,
      invocation: runtime.resolveSkillInvocation(
        requiredString(body.invocation, 'invocation'),
        profile,
      ),
    };
  });

  // SkillApp source stays server-owned. Every renderer receives the same
  // statically compiled JSON contract and can only submit typed state.
  server.get('/v1/apps', async () => ({
    ok: true,
    apps: runtime.listApps().map(publicSkillAppDefinition),
  }));

  server.get<{
    Params: { name: string };
  }>('/v1/apps/:name', async (request, reply) => {
    const app = runtime.getApp(request.params.name);
    if (!app) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: 'APP_NOT_FOUND',
          message: `App not found: ${request.params.name}`,
        },
      };
    }
    return { ok: true, app: publicSkillAppDefinition(app) };
  });

  // SkillApps are statically compiled templates with ephemeral service-owned
  // state. Both buttons and on-change triggers execute the same declared
  // app-local/model or profile/Skill operation and return a normalized result.
  server.post<{
    Params: { name: string };
  }>('/v1/apps/:name/instances', async (request, reply) => {
    const instance = skillAppInstances.create(request.params.name);
    reply.status(201);
    return { ok: true, instance };
  });

  server.get<{
    Params: { id: string };
  }>('/v1/app-instances/:id', async request => ({
    ok: true,
    instance: skillAppInstances.get(request.params.id),
  }));

  server.patch<{
    Params: { id: string };
  }>('/v1/app-instances/:id/state', async request => {
    const body = objectBody(request.body);
    return {
      ok: true,
      ...(await skillAppInstances.update(request.params.id, objectBody(body.values))),
    };
  });

  server.put<{
    Params: { id: string; state: string };
  }>('/v1/app-instances/:id/attachments/:state', async request => {
    const body = objectBody(request.body);
    if (!Array.isArray(body.attachments)) {
      throw MarifoldError.configInvalid('attachments must be an array.');
    }
    return {
      ok: true,
      ...skillAppInstances.updateAttachments(
        request.params.id,
        request.params.state,
        body.attachments as unknown as SkillAppAttachmentInput[],
      ),
    };
  });

  server.post<{
    Params: { id: string; operation: string };
  }>('/v1/app-instances/:id/operations/:operation', async request => ({
    ok: true,
    ...(await skillAppInstances.run(request.params.id, request.params.operation)),
  }));

  server.post<{
    Params: { id: string; executionId: string };
  }>('/v1/app-instances/:id/executions/:executionId/input', async request => ({
    ok: true,
    instance: skillAppInstances.answerUserInput(
      request.params.id,
      request.params.executionId,
      objectBody(request.body),
    ),
  }));

  server.post<{
    Params: { id: string; executionId: string };
  }>('/v1/app-instances/:id/executions/:executionId/approval', async request => {
    const body = objectBody(request.body);
    const action = requiredString(body.action, 'action');
    if (action !== 'once' && action !== 'deny') {
      throw MarifoldError.configInvalid('SkillApp approval action must be "once" or "deny".');
    }
    return {
      ok: true,
      instance: skillAppInstances.answerApproval(
        request.params.id,
        request.params.executionId,
        action,
      ),
    };
  });

  server.post<{
    Params: { id: string; executionId: string };
  }>('/v1/app-instances/:id/executions/:executionId/cancel', async request => ({
    ok: true,
    instance: skillAppInstances.cancelExecution(request.params.id, request.params.executionId),
  }));

  server.delete<{
    Params: { id: string };
  }>('/v1/app-instances/:id', async request => ({
    ok: true,
    deleted: skillAppInstances.delete(request.params.id),
  }));
}

function publicSkillAppDefinition(definition: SkillAppDefinition): SkillAppDefinition {
  const { permissions: _permissions, ...publicDefinition } = definition;
  return publicDefinition;
}

function skillHint(skill: MarifoldSkill): JsonObject {
  const vars = skill.variables
    .map(variable => (variable.required ? `<${variable.name}>` : `[${variable.name}]`))
    .join(' ');
  return {
    name: skill.name,
    description: skill.description,
    usage: `$${skill.name}${vars ? ` ${vars}` : ''}`,
  };
}
