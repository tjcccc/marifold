export type MarifoldErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_MISSING_PROVIDER_MODEL'
  | 'PROFILE_INVALID'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'API_KEY_MISSING'
  | 'MEMORY_INVALID'
  | 'TASK_INVALID'
  | 'TASK_NOT_FOUND'
  | 'SESSION_STORE_ERROR'
  | 'WORKSPACE_ALREADY_INITIALIZED'
  | 'AGENT_TOOL_INVALID'
  | 'AGENT_RUN_INVALID'
  | 'SCHEDULE_INVALID'
  | 'SCHEDULE_NOT_FOUND';

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

  static workspaceAlreadyInitialized(configPath: string): MarifoldError {
    return new MarifoldError(
      'WORKSPACE_ALREADY_INITIALIZED',
      `Marifold is already initialized at ${configPath}. Use --force to rewrite config.toml.`,
      { configPath },
    );
  }
}
