import { FastifyInstance } from 'fastify';
import {
  listProviderRegistry,
  LoadedMarifoldConfig,
  MarifoldError,
  MarifoldProviderConfig,
  MarifoldRuntime,
  resolveAgentConfig,
  resolveWebSearchConfig,
} from '@marifold/core';
import { JsonObject, objectBody, optionalStringField, requiredString, stringValue } from './Validation';

/** Config, provider, and model management. Responses expose env-var names and
 * presence flags only; raw keys and tokens never cross the wire. */
export function registerConfigRoutes(
  server: FastifyInstance,
  runtime: MarifoldRuntime,
  options: { loadedConfig: LoadedMarifoldConfig },
  security: { token?: string },
): void {
  server.get('/v1/config', async () => ({
    ok: true,
    config: publicConfig(options.loadedConfig, Boolean(security.token)),
  }));

  // Mirrors the CLI's `config set <key> <value>` exactly (same dotted-key
  // routing and validation); returns the sanitized view, never raw secrets.
  server.patch('/v1/config', async request => {
    const body = objectBody(request.body);
    runtime.setConfigValue(requiredString(body.key, 'key'), stringValue(body.value, 'value'));
    return { ok: true, config: publicConfig(options.loadedConfig, Boolean(security.token)) };
  });

  server.get('/v1/providers', async () => ({
    ok: true,
    providers: Object.entries(options.loadedConfig.config.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, provider]) => ({
        name,
        ...publicProvider(provider),
      })),
  }));

  // The same ordered provider catalog that backs `marifold provider add`.
  // Only setup metadata crosses the wire; known-model lists have their own
  // live/fallback routes and credentials are never part of this response.
  server.get('/v1/providers/catalog', async () => ({
    ok: true,
    providers: listProviderRegistry().map(provider => ({
      name: provider.name,
      label: provider.label,
      kind: provider.kind,
      type: provider.type,
      ...(provider.defaultBaseUrl ? { defaultBaseUrl: provider.defaultBaseUrl } : {}),
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    })),
  }));

  // Add one registry provider with shared CLI defaults. Raw keys/tokens are
  // intentionally ignored: browser clients may store env-var names only.
  server.post('/v1/providers', async (request, reply) => {
    const body = objectBody(request.body);
    runtime.addProvider(requiredString(body.name, 'name').trim(), {
      ...optionalStringField('baseUrl', body.baseUrl),
      ...optionalStringField('apiKeyEnv', body.apiKeyEnv),
      ...optionalStringField('proxy', body.proxy),
    });
    reply.status(201);
    return { ok: true, config: publicConfig(options.loadedConfig, Boolean(security.token)) };
  });

  // Live reachability probe for every provider (CLI `provider status`).
  // Sanitized: key/token presence booleans and env-var *names* only.
  server.get('/v1/providers/status', async () => ({
    ok: true,
    providers: await runtime.providerStatus(),
  }));

  // Models the provider actually serves right now (feeds the model picker).
  server.get<{ Params: { name: string } }>('/v1/providers/:name/models', async request => ({
    ok: true,
    ...(await runtime.listProviderModels(request.params.name)),
  }));

  server.delete<{ Params: { name: string } }>('/v1/providers/:name', async request => {
    const result = runtime.removeProvider(request.params.name);
    return {
      ok: true,
      ...result,
      config: publicConfig(options.loadedConfig, Boolean(security.token)),
      models: modelsView(options.loadedConfig),
    };
  });

  server.get('/v1/models', async () => ({
    ok: true,
    default: {
      provider: options.loadedConfig.config.default.provider,
      model: options.loadedConfig.config.default.model,
    },
    options: [...options.loadedConfig.config.models.options],
  }));

  // Model management (CLI `model add`/`rm`/`default`). Provider entries may be
  // created/updated here, but never with secrets — raw api_key values stay
  // CLI/file-only by design; the wire accepts the env-var *name* at most.
  server.post('/v1/models', async (request, reply) => {
    const body = objectBody(request.body);
    runtime.addModelOption(requiredString(body.provider, 'provider'), requiredString(body.model, 'model'), {
      ...(body.type !== undefined ? { type: parseProviderTypeField(body.type) } : {}),
      ...optionalStringField('baseUrl', body.baseUrl),
      ...optionalStringField('apiKeyEnv', body.apiKeyEnv),
    });
    reply.status(201);
    return modelsView(options.loadedConfig);
  });

  server.delete('/v1/models', async request => {
    const body = objectBody(request.body);
    const result = runtime.removeModelOption(
      requiredString(body.provider, 'provider'),
      requiredString(body.model, 'model'),
    );
    return { ...modelsView(options.loadedConfig), ...result };
  });

  server.put('/v1/models/default', async request => {
    const body = objectBody(request.body);
    runtime.setDefaultModel(requiredString(body.provider, 'provider'), requiredString(body.model, 'model'));
    return modelsView(options.loadedConfig);
  });
}

const PROVIDER_TYPES = ['ollama', 'openai-compatible', 'anthropic'] as const;

function parseProviderTypeField(value: unknown): (typeof PROVIDER_TYPES)[number] {
  const type = stringValue(value, 'type');
  const known = PROVIDER_TYPES.find(candidate => candidate === type);
  if (!known) { throw MarifoldError.configInvalid(`type must be one of ${PROVIDER_TYPES.join(', ')}.`); }
  return known;
}

/** The GET /v1/models payload — returned by every model write for refresh-free clients. */
function modelsView(loadedConfig: LoadedMarifoldConfig): JsonObject {
  return {
    ok: true,
    default: {
      provider: loadedConfig.config.default.provider,
      model: loadedConfig.config.default.model,
    },
    options: [...loadedConfig.config.models.options],
  };
}

function publicConfig(loadedConfig: LoadedMarifoldConfig, hasEffectiveToken: boolean): JsonObject {
  const service = loadedConfig.config.service;
  return {
    default: loadedConfig.config.default,
    models: loadedConfig.config.models,
    memory: loadedConfig.config.memory,
    paths: loadedConfig.config.paths,
    // Resolved (defaults merged) and secret-free — clients need the global
    // [agent] to compute a profile's effective permissions.
    agent: resolveAgentConfig(loadedConfig.config.agent) as unknown as JsonObject,
    webSearch: (() => {
      const search = resolveWebSearchConfig(loadedConfig.config.webSearch);
      return {
        enabled: search.enabled,
        maxResults: search.maxResults,
        provider: search.provider,
        ...(search.apiKeyEnv ? { apiKeyEnv: search.apiKeyEnv } : {}),
        ...(search.scrape !== undefined ? { scrape: search.scrape } : {}),
        ...(search.proxy ? { proxy: search.proxy } : {}),
        hasApiKey: Boolean(search.apiKey),
      };
    })(),
    // Sanitized [service] view: the token value never leaves the process.
    service: {
      ...(service?.webDir ? { webDir: service.webDir } : {}),
      ...(service?.tokenEnv ? { tokenEnv: service.tokenEnv } : {}),
      corsOrigins: service?.corsOrigins ?? [],
      hasToken: hasEffectiveToken,
    },
    providers: Object.fromEntries(
      Object.entries(loadedConfig.config.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, provider]) => [name, publicProvider(provider)]),
    ),
  };
}

function publicProvider(provider: MarifoldProviderConfig): JsonObject {
  return {
    type: provider.type,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    // proxy is a non-secret URL like baseUrl, so it crosses the wire in the
    // clear (unlike api_key). A proxy URL *can* embed credentials
    // (user:pass@host); that's the caller's choice, same as a secret in baseUrl.
    ...(provider.proxy ? { proxy: provider.proxy } : {}),
    ...(provider.nativeWebSearch ? { nativeWebSearch: provider.nativeWebSearch } : {}),
    hasApiKey: Boolean(provider.apiKey),
    hasOauthToken: Boolean(provider.oauthToken),
    hasApiKeyExpiresAt: provider.apiKeyExpiresAt !== undefined,
  };
}
