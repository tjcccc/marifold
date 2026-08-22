export type MarifoldErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_MISSING_PROVIDER_MODEL'
  | 'IMAGE_INVALID'
  | 'PROFILE_INVALID'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'API_KEY_MISSING'
  | 'MEMORY_INVALID'
  | 'TASK_INVALID'
  | 'TASK_NOT_FOUND'
  | 'SESSION_STORE_ERROR'
  | 'WORKSPACE_ALREADY_INITIALIZED'
  | 'AGENT_TOOL_INVALID'
  | 'AGENT_RUN_INVALID'
  | 'SCHEDULE_INVALID'
  | 'SCHEDULE_NOT_FOUND'
  | 'SKILL_INVALID'
  | 'SKILL_NOT_FOUND'
  | 'APP_INVALID'
  | 'APP_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'APPROVAL_NOT_FOUND'
  | 'USER_INPUT_NOT_FOUND'
  | 'RUN_LIMIT_EXCEEDED'
  | 'UNAUTHORIZED'
  | 'NETWORK_FORBIDDEN'
  | 'ORIGIN_FORBIDDEN';

export class MarifoldError extends Error {
  readonly code: MarifoldErrorCode;
  readonly details: Record<string, string>;

  constructor(code: MarifoldErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'MarifoldError';
    this.code = code;
    this.details = details;
  }

  static configInvalid(message: string, details: Record<string, string> = {}): MarifoldError {
    return new MarifoldError('CONFIG_INVALID', message, details);
  }

  static imageInvalid(message: string, details: Record<string, string> = {}): MarifoldError {
    return new MarifoldError('IMAGE_INVALID', message, details);
  }

  static configFileNotFound(path: string): MarifoldError {
    return new MarifoldError(
      'CONFIG_FILE_NOT_FOUND',
      `Config file not found: ${path}`,
      { path },
    );
  }

  static missingProviderModel(configPath: string): MarifoldError {
    return new MarifoldError(
      'CONFIG_MISSING_PROVIDER_MODEL',
      `Provider and model are not configured. Set [default].provider and [default].model in ${configPath}, or pass --provider and --model.`,
      { configPath },
    );
  }

  static profileInvalid(message: string, profile: string): MarifoldError {
    return new MarifoldError('PROFILE_INVALID', message, { profile });
  }

  static providerNotConfigured(provider: string, configPath: string): MarifoldError {
    return new MarifoldError(
      'PROVIDER_NOT_CONFIGURED',
      `Provider '${provider}' is not configured in ${configPath}. Add a [providers.${provider}] table.`,
      { provider, configPath },
    );
  }

  static providerError(
    message: string,
    provider: string,
    model: string,
    upstreamCode?: string,
  ): MarifoldError {
    return new MarifoldError(
      'PROVIDER_ERROR',
      message,
      {
        provider,
        model,
        ...(upstreamCode ? { upstreamCode } : {}),
      },
    );
  }

  static apiKeyMissing(provider: string, envVar: string): MarifoldError {
    return new MarifoldError(
      'API_KEY_MISSING',
      `Provider '${provider}' requires ${envVar}. Set the environment variable before running Marifold.`,
      { provider, envVar },
    );
  }

  static memoryInvalid(message: string, profile: string): MarifoldError {
    return new MarifoldError('MEMORY_INVALID', message, { profile });
  }

  static taskInvalid(message: string, taskId?: string): MarifoldError {
    return new MarifoldError('TASK_INVALID', message, taskId ? { taskId } : {});
  }

  static taskNotFound(taskId: string): MarifoldError {
    return new MarifoldError('TASK_NOT_FOUND', `Task not found: ${taskId}`, { taskId });
  }

  static agentToolInvalid(message: string, tool?: string): MarifoldError {
    return new MarifoldError('AGENT_TOOL_INVALID', message, tool ? { tool } : {});
  }

  static agentRunInvalid(message: string): MarifoldError {
    return new MarifoldError('AGENT_RUN_INVALID', message);
  }

  static scheduleInvalid(message: string, scheduleId?: string): MarifoldError {
    return new MarifoldError('SCHEDULE_INVALID', message, scheduleId ? { schedule_id: scheduleId } : {});
  }

  static scheduleNotFound(scheduleId: string): MarifoldError {
    return new MarifoldError('SCHEDULE_NOT_FOUND', `Schedule not found: ${scheduleId}`, { schedule_id: scheduleId });
  }

  static skillInvalid(message: string, source?: string): MarifoldError {
    return new MarifoldError('SKILL_INVALID', message, source ? { source } : {});
  }

  static skillNotFound(name: string): MarifoldError {
    return new MarifoldError('SKILL_NOT_FOUND', `Skill not found: ${name}`, { name });
  }

  static appInvalid(message: string, source?: string): MarifoldError {
    return new MarifoldError('APP_INVALID', message, source ? { source } : {});
  }

  static appNotFound(name: string): MarifoldError {
    return new MarifoldError('APP_NOT_FOUND', `App not found: ${name}`, { name });
  }

  static runNotFound(runId: string): MarifoldError {
    return new MarifoldError('RUN_NOT_FOUND', `Run not found: ${runId}`, { runId });
  }

  static approvalNotFound(requestId: string): MarifoldError {
    return new MarifoldError(
      'APPROVAL_NOT_FOUND',
      `No pending approval with id ${requestId}. It may have expired, been answered, or belong to another run.`,
      { requestId },
    );
  }

  static userInputNotFound(requestId: string): MarifoldError {
    return new MarifoldError(
      'USER_INPUT_NOT_FOUND',
      `No pending user-input request with id ${requestId}. It may have expired, been answered, or belong to another run.`,
      { requestId },
    );
  }

  static runLimitExceeded(max: number): MarifoldError {
    return new MarifoldError(
      'RUN_LIMIT_EXCEEDED',
      `Too many active agent runs (limit ${max}). Wait for a run to finish or cancel one.`,
      { max: String(max) },
    );
  }

  static unauthorized(): MarifoldError {
    return new MarifoldError('UNAUTHORIZED', 'Missing or invalid bearer token.');
  }

  static networkForbidden(address: string): MarifoldError {
    return new MarifoldError(
      'NETWORK_FORBIDDEN',
      `Network source not allowed: ${address}. Marifold accepts only loopback, private LAN, link-local, and private overlay-network clients.`,
      { address },
    );
  }

  static originForbidden(origin: string): MarifoldError {
    return new MarifoldError(
      'ORIGIN_FORBIDDEN',
      `Origin not allowed: ${origin}. Add it to [service].cors_origins.`,
      { origin },
    );
  }

  static workspaceAlreadyInitialized(configPath: string): MarifoldError {
    return new MarifoldError(
      'WORKSPACE_ALREADY_INITIALIZED',
      `Marifold is already initialized at ${configPath}. Use --force to rewrite config.toml.`,
      { configPath },
    );
  }
}
