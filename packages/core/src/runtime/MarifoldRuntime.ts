import { PriestConfig, PriestEngine } from '@priest-ai/core';
import { LoadedMarifoldConfig, ProfileSummary, SessionDetail, SessionSummary } from '../config/ConfigSchema';
import { ProviderFactory } from '../config/ProviderFactory';
import { MarifoldError } from '../errors/MarifoldError';
import { ProfileResolver } from '../profiles/ProfileResolver';
import { SessionResolver } from '../sessions/SessionResolver';
import { MarifoldAskResponse, MarifoldResolvedSettings, MarifoldRunRequest } from './MarifoldTypes';

export interface MarifoldRuntimeOptions {
  loadedConfig: LoadedMarifoldConfig;
}

export class MarifoldRuntime {
  private readonly profileResolver: ProfileResolver;
  private readonly sessionResolver: SessionResolver;
  private readonly providerFactory: ProviderFactory;

  constructor(private readonly options: MarifoldRuntimeOptions) {
    const { config, configPath } = options.loadedConfig;
    this.profileResolver = new ProfileResolver(config.paths.profilesDir);
    this.sessionResolver = new SessionResolver(config.paths.sessionsDb);
    this.providerFactory = new ProviderFactory(config, configPath);
  }

  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model'>): MarifoldResolvedSettings {
    const { config, configPath } = this.options.loadedConfig;
    const profile = request.profile ?? config.default.profile;
    const profileSettings = this.profileResolver.loadSettings(profile);
    const provider = request.provider ?? profileSettings.provider ?? config.default.provider;
    const model = request.model ?? profileSettings.model ?? config.default.model;
    if (!provider || !model) throw MarifoldError.missingProviderModel(configPath);
    return { profile, provider, model };
  }

  async ask(request: MarifoldRunRequest): Promise<MarifoldAskResponse> {
    const settings = this.resolveSettings(request);
    const engine = this.createEngine(settings.provider, Boolean(request.sessionId));
    const response = await engine.run({
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: ['Running inside Marifold CLI.'],
    });

    return {
      ok: response.ok,
      text: response.text ?? '',
      settings,
      latencyMs: response.execution.latencyMs,
      session: response.session,
      error: response.error ? { code: response.error.code, message: response.error.message } : undefined,
    };
  }

  async *stream(request: MarifoldRunRequest): AsyncGenerator<string, void, unknown> {
    const settings = this.resolveSettings(request);
    const engine = this.createEngine(settings.provider, Boolean(request.sessionId));
    yield* engine.stream({
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: ['Running inside Marifold CLI.'],
    });
  }

  listProfiles(): ProfileSummary[] {
    return this.profileResolver.list();
  }

  listSessions(limit?: number): SessionSummary[] {
    return this.sessionResolver.list(limit);
  }

  getSession(sessionId: string): SessionDetail | undefined {
    return this.sessionResolver.get(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessionResolver.delete(sessionId);
  }

  renameSession(fromSessionId: string, toSessionId: string): boolean {
    return this.sessionResolver.rename(fromSessionId, toSessionId);
  }

  close(): void {
    this.sessionResolver.close();
  }

  private createEngine(providerName: string, useSession: boolean): PriestEngine {
    const adapter = this.providerFactory.create(providerName);
    return new PriestEngine(
      this.profileResolver,
      useSession ? this.sessionResolver.openStore() : undefined,
      { [providerName]: adapter },
    );
  }

  private toPriestConfig(settings: MarifoldResolvedSettings): PriestConfig {
    const { config } = this.options.loadedConfig;
    return {
      provider: settings.provider,
      model: settings.model,
      timeoutSeconds: config.default.timeoutSeconds,
      maxOutputTokens: config.default.maxOutputTokens,
      maxSystemChars: config.default.maxSystemChars,
    };
  }
}
