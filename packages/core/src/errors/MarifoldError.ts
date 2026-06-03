export type MarifoldErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_MISSING_PROVIDER_MODEL'
  | 'PROFILE_INVALID'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'API_KEY_MISSING'
  | 'MEMORY_INVALID'
  | 'SESSION_STORE_ERROR'
  | 'WORKSPACE_ALREADY_INITIALIZED';

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

  static workspaceAlreadyInitialized(configPath: string): MarifoldError {
    return new MarifoldError(
      'WORKSPACE_ALREADY_INITIALIZED',
      `Marifold is already initialized at ${configPath}. Use --force to rewrite config.toml.`,
      { configPath },
    );
  }
}
