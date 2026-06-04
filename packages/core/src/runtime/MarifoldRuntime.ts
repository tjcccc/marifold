import { PriestConfig, PriestEngine } from '@priest-ai/core';
import { ConfigManager } from '../config/ConfigManager';
import { LoadedMarifoldConfig, ProfileDetail, ProfileSummary, SessionDetail, SessionSummary } from '../config/ConfigSchema';
import { exchangeGitHubTokenForCopilotToken } from '../config/GitHubCopilotAuth';
import { ProviderFactory } from '../config/ProviderFactory';
import { MarifoldError } from '../errors/MarifoldError';
import { MemoryStore } from '../memory/MemoryStore';
import type { MemoryKind, MemoryMutationResult, MemoryRememberResult, MemoryScaffoldFile } from '../memory/MemoryStore';
import {
  MemoryControlStripper,
  buildMemoryInstructions,
  extractPromptMemoryInputs,
  shouldInjectMemoryInstructions,
  stripMemoryControls,
} from '../memory/MemoryControls';
import type { MemoryControlPayloads } from '../memory/MemoryControls';
import { ProfileResolver } from '../profiles/ProfileResolver';
import { SessionResolver } from '../sessions/SessionResolver';
import { MarifoldAskResponse, MarifoldResolvedSettings, MarifoldRunRequest } from './MarifoldTypes';

const THINK_PROVIDER_NAMES = new Set(['bailian', 'alibaba_cloud']);

export interface MarifoldRuntimeOptions {
  loadedConfig: LoadedMarifoldConfig;
}

export class MarifoldRuntime {
  private readonly profileResolver: ProfileResolver;
  private readonly sessionResolver: SessionResolver;
  private readonly providerFactory: ProviderFactory;
  private readonly memoryStore: MemoryStore;

  constructor(private readonly options: MarifoldRuntimeOptions) {
    const { config, configPath } = options.loadedConfig;
    this.profileResolver = new ProfileResolver(config.paths.profilesDir);
    this.sessionResolver = new SessionResolver(config.paths.sessionsDb);
    this.providerFactory = new ProviderFactory(config, configPath);
    this.memoryStore = new MemoryStore(config.paths.profilesDir);
  }

  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think'>): MarifoldResolvedSettings {
    const { config, configPath } = this.options.loadedConfig;
    const profile = request.profile ?? config.default.profile;
    const profileSettings = this.profileResolver.loadSettings(profile);
    const provider = request.provider ?? profileSettings.provider ?? config.default.provider;
    const model = request.model ?? profileSettings.model ?? config.default.model;
    const think = request.think ?? config.default.think;
    if (!provider || !model) throw MarifoldError.missingProviderModel(configPath);
    return { profile, provider, model, think };
  }

  async ask(request: MarifoldRunRequest): Promise<MarifoldAskResponse> {
    const settings = this.resolveSettings(request);
    await this.refreshProviderCredentialsIfNeeded(settings.provider);
    const engine = this.createEngine(settings.provider, Boolean(request.sessionId));
    const memoryOn = this.memoryEnabled(settings.profile, request.memories);
    const memory = this.memoryForRequest(settings.profile, request.memories);
    const response = await engine.run({
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: this.runtimeContext(memory, request.prompt, memoryOn),
      memory,
    });
    const stripped = stripMemoryControls(response.text ?? '');
    if (response.ok && request.sessionId) {
      this.sessionResolver.replaceLastAssistantTurn(request.sessionId, stripped.text);
    }
    if (response.ok && memoryOn) {
      this.applyTurnMemory(settings.profile, request.prompt, stripped, request.sessionId);
    }

    return {
      ok: response.ok,
      text: stripped.text,
      settings,
      latencyMs: response.execution.latencyMs,
      session: response.session,
      error: response.error ? { code: response.error.code, message: response.error.message } : undefined,
    };
  }

  async *stream(request: MarifoldRunRequest): AsyncGenerator<string, void, unknown> {
    const settings = this.resolveSettings(request);
    await this.refreshProviderCredentialsIfNeeded(settings.provider);
    const engine = this.createEngine(settings.provider, Boolean(request.sessionId));
    const memoryOn = this.memoryEnabled(settings.profile, request.memories);
    const memory = this.memoryForRequest(settings.profile, request.memories);
    const stripper = new MemoryControlStripper();
    const visibleParts: string[] = [];
    for await (const chunk of engine.stream({
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: this.runtimeContext(memory, request.prompt, memoryOn),
      memory,
    })) {
      const visible = stripper.feed(chunk);
      if (visible) {
        visibleParts.push(visible);
        yield visible;
      }
    }
    const tail = stripper.flush();
    if (tail) {
      visibleParts.push(tail);
      yield tail;
    }
    if (request.sessionId) {
      this.sessionResolver.replaceLastAssistantTurn(request.sessionId, visibleParts.join(''));
    }
    if (memoryOn) {
      this.applyTurnMemory(settings.profile, request.prompt, stripper, request.sessionId);
    }
  }

  rememberMemory(
    profile: string,
    kind: MemoryKind,
    text: string,
    sessionId?: string,
  ): MemoryRememberResult {
    return this.memoryStore.remember(profile, kind, text, { sessionId });
  }

  forgetMemories(profile: string, query: string): MemoryMutationResult {
    return this.memoryStore.forget(profile, query);
  }

  deleteMemories(profile: string, query: string): MemoryMutationResult {
    return this.memoryStore.delete(profile, query);
  }

  ensureProfileMemoryFiles(profile: string): MemoryScaffoldFile[] {
    this.profileResolver.load(profile);
    return this.memoryStore.ensureProfile(profile);
  }

  memoryEnabled(profile: string, requestMemories = true): boolean {
    return requestMemories && this.profileResolver.loadSettings(profile).memories;
  }

  listProfiles(): ProfileSummary[] {
    return this.profileResolver.list();
  }

  getProfile(name: string): ProfileDetail {
    return this.profileResolver.detail(name);
  }

  listSessions(limit?: number, profileName?: string): SessionSummary[] {
    return this.sessionResolver.list(limit, profileName);
  }

  latestSession(profileName?: string): SessionSummary | undefined {
    return this.sessionResolver.latest(profileName);
  }

  getSession(sessionId: string): SessionDetail | undefined {
    return this.sessionResolver.get(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessionResolver.delete(sessionId);
  }

  clearSessions(options: { profileName?: string; before?: string; keepLast?: number } = {}): { count: number; ids: string[] } {
    return this.sessionResolver.clear(options);
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

  private async refreshProviderCredentialsIfNeeded(providerName: string): Promise<void> {
    if (providerName !== 'github_copilot') return;

    const provider = this.options.loadedConfig.config.providers[providerName];
    if (!provider?.oauthToken) return;
    if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return;

    const refreshWindowSeconds = 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      provider.apiKey
      && provider.apiKeyExpiresAt !== undefined
      && provider.apiKeyExpiresAt > nowSeconds + refreshWindowSeconds
    ) {
      return;
    }

    try {
      const refreshed = await exchangeGitHubTokenForCopilotToken(provider.oauthToken);
      provider.apiKey = refreshed.token;
      provider.baseUrl = refreshed.baseUrl;
      provider.apiKeyExpiresAt = refreshed.expiresAt;
      new ConfigManager(this.options.loadedConfig).save();
    } catch (error) {
      throw MarifoldError.configInvalid(
        `GitHub Copilot authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Re-run marifold model add github_copilot to authorize again.`,
      );
    }
  }

  private toPriestConfig(settings: MarifoldResolvedSettings): PriestConfig {
    const { config } = this.options.loadedConfig;
    return {
      provider: settings.provider,
      model: settings.model,
      timeoutSeconds: config.default.timeoutSeconds,
      maxOutputTokens: config.default.maxOutputTokens,
      maxSystemChars: config.default.maxSystemChars,
      providerOptions: this.supportsThink(settings.provider) ? { think: settings.think } : undefined,
    };
  }

  private supportsThink(providerName: string): boolean {
    const provider = this.options.loadedConfig.config.providers[providerName];
    return provider?.type === 'ollama' || THINK_PROVIDER_NAMES.has(providerName);
  }

  private memoryForRequest(profile: string, requestMemories = true): string[] {
    const { config } = this.options.loadedConfig;
    if (!this.memoryEnabled(profile, requestMemories)) return [];
    this.ensureProfileMemoryFiles(profile);
    return this.memoryStore.listPromptMemory(profile, { contextLimit: config.memory.contextLimit });
  }

  private runtimeContext(memory: string[], prompt: string, memoryOn: boolean): string[] {
    const context = ['Running inside Marifold CLI.'];
    if (memoryOn) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
      if (shouldInjectMemoryInstructions(prompt)) context.push(buildMemoryInstructions());
    } else if (memory.length > 0) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
    }
    return context;
  }

  private applyTurnMemory(
    profile: string,
    prompt: string,
    controls: MemoryControlPayloads,
    sessionId?: string,
  ): void {
    this.memoryStore.applySavePayloads(profile, controls.savePayloads, { sessionId });
    this.memoryStore.applyForgetPayloads(profile, controls.forgetPayloads);
    this.memoryStore.save(profile, extractPromptMemoryInputs(prompt), { sessionId });
  }
}
