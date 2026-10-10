import { SessionLeases } from '../sessions/SessionLeases';
import { randomUUID as leaseOwnerId } from 'node:crypto';
import { SudoExecTool } from '../agent/tools/SudoExecTool';
import { DeviceExecution } from '../agent/DeviceExecution';
import { ShellJobStatusTool } from '../agent/tools/ShellJobStatusTool';
import type { RuntimeEnvironment } from './RuntimeEnvironment';
import type { AgentRunnerDeps } from '../agent/AgentRunner';
import type { RunStartInput, RunJournal } from '../runs/RunRegistry';
import type { ImageInput, UsageInfo } from '@priest-ai/core';
import * as path from 'path';
import { AgentRunner } from '../agent/AgentRunner';
import { type ApprovalMode, type MarifoldAgentConfig, type ToolKind, resolveAgentConfig } from '../agent/ApprovalPolicy';
import { DelegateTool } from '../agent/tools/DelegateTool';
import { PythonPackageTool } from '../agent/tools/PythonPackageTool';
import { ReadAttachmentTool } from '../agent/tools/ReadAttachmentTool';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { SearchAttachmentTool } from '../agent/tools/SearchAttachmentTool';
import { ShellExecTool } from '../agent/tools/ShellExecTool';
import { ReadWebPageTool } from '../agent/tools/ReadWebPageTool';
import { WebPageReader } from '../search/WebPageReader';
import { WebSearchTool } from '../agent/tools/WebSearchTool';
import { AskUserTool } from '../agent/tools/AskUserTool';
import { InspectAttachmentTool } from '../agent/tools/InspectAttachmentTool';
import { WriteFileTool } from '../agent/tools/WriteFileTool';
import { SkillManagementTool } from '../agent/tools/SkillManagementTool';
import { SkillAppContextTool, SkillAppManagementTool } from '../agent/tools/SkillAppTools';
import { ToolRegistry } from '../agent/ToolRegistry';
import { ConfigManager } from '../config/ConfigManager';
import type { ConfigAddProviderOptions } from '../config/ConfigManager';
import { type LoadedMarifoldConfig, type ProfileDetail, type ProfileMode, type ProfileSummary, type ProviderType, resolveWebSearchConfig, type SessionDetail, type SessionSummary } from '../config/ConfigSchema';
import { ProviderInspector } from '../config/ProviderInspector';
import type { ProviderModelList, ProviderStatus } from '../config/ProviderInspector';
import { createSearchBackend } from '../search/createSearchBackend';
import { formatSearchResults, type SearchBackend } from '../search/SearchBackend';
import { ProviderFactory, type NativeWebSearchStrategy } from '../config/ProviderFactory';
import { getProviderRegistryEntry } from '../config/ProviderRegistry';
import { MarifoldError } from '../errors/MarifoldError';
import { prepareImageInputs } from '../images/ImageOptimizer';
import { MemoryStore } from '../memory/MemoryStore';
import type { MemoryEntry, MemoryKind, MemoryMutationResult, MemoryRememberResult, MemoryScaffoldFile } from '../memory/MemoryStore';
import { ProfileResolver } from '../profiles/ProfileResolver';
import { ProfileManager } from '../profiles/ProfileManager';
import type { ProfileFileKind, ProfileInstructionsMigrationResult } from '../profiles/ProfileManager';
import { Scheduler } from '../schedule/Scheduler';
import { RunRegistry } from '../runs/RunRegistry';
import { TelegramBridge } from '../channels/TelegramBridge';
import { type ScheduleCreateInput, type ScheduleState, ScheduleStore, type ScheduleUpdateInput } from '../schedule/ScheduleStore';
import {
  SessionResolver,
  type SessionDbHealth,
  type SessionDisplayUpdate,
  type SessionListOptions,
  type SessionTruncateResult,
} from '../sessions/SessionResolver';
import type { ResponseMetrics } from '../sessions/ResponseMetrics';
import { SkillStore } from '../skill/SkillStore';
import type { MarifoldSkill } from '../skill/SkillSchema';
import type { SkillScope } from '../skill/SkillStore';
import {
  parseSkillInvocation,
  resolveSkillInvocation as resolveSkillInvocationDefinition,
} from '../skill/SkillInvocation';
import type { ResolvedSkillInvocation } from '../skill/SkillInvocation';
import { buildSkillManagerGuide, mentionsSkills } from '../skill/BuiltInSkillManager';
import { getBuiltInSkill, listBuiltInSkills } from '../skill/BuiltInSkills';
import { buildSkillAppBuilderGuide, mentionsSkillApps } from '../skill/BuiltInSkillAppBuilder';
import { AppStore } from '../app/AppStore';
import type {
  SkillAppDefinition,
  SkillAppAttachmentInput,
  SkillAppHistoryTurn,
  SkillAppResult,
  SkillAppStateValue,
} from '../app/SkillAppSchema';
import {
  SkillAppInstanceRegistry,
  type SkillAppInteractionHandlers,
} from '../app/SkillAppInstanceRegistry';
import { TaskStore } from '../tasks/TaskStore';
import { defaultAppsDir, defaultSchedulesDir, defaultSkillsDir } from '../workspace/WorkspacePaths';
import type { TaskCreateInput, TaskEventInput, TaskListOptions, TaskState, TaskSummary, TaskUpdateInput } from '../tasks/TaskStore';
import type { MarifoldAskResponse, MarifoldProviderToolDefinition, MarifoldResolvedSettings, MarifoldRunRequest, MarifoldWebSearchMode } from './MarifoldTypes';
import { ProviderEngines } from './ProviderEngines';
import { ChatTurns } from './ChatTurns';
import { SkillAppOperations } from './SkillAppOperations';


export interface MarifoldRuntimeOptions {
  environment?: RuntimeEnvironment;
  loadedConfig: LoadedMarifoldConfig;
  /** Override the web search backend (tests, alternative engines). */
  searchBackend?: SearchBackend;
}

export class MarifoldRuntime {
  private readonly profileResolver: ProfileResolver;
  private readonly profileManager: ProfileManager;
  private readonly sessionResolver: SessionResolver;
  private readonly sessionLeases: SessionLeases;
  private readonly sessionOwner = leaseOwnerId();
  private readonly providerFactory: ProviderFactory;
  private readonly engines: ProviderEngines;
  private readonly skillApps: SkillAppOperations;
  private readonly chat: ChatTurns;
  private readonly memoryStore: MemoryStore;
  private readonly taskStore: TaskStore;
  private searchBackend: SearchBackend;
  private readonly searchBackendOverridden: boolean;
  private readonly scheduleStore: ScheduleStore;

  constructor(private readonly options: MarifoldRuntimeOptions) {
    const { config, configPath } = options.loadedConfig;
    this.sessionLeases = new SessionLeases(`${config.paths.sessionsDb}.leases`);
    this.profileResolver = new ProfileResolver(config.paths.profilesDir);
    this.profileManager = new ProfileManager(config.paths.profilesDir);
    this.sessionResolver = new SessionResolver(config.paths.sessionsDb);
    this.providerFactory = new ProviderFactory(config, configPath);
    this.engines = new ProviderEngines(options.loadedConfig, this.providerFactory, this.profileResolver, this.sessionResolver);
    this.memoryStore = new MemoryStore(config.paths.profilesDir);
    this.taskStore = new TaskStore(config.paths.tasksDir);
    this.searchBackendOverridden = options.searchBackend !== undefined;
    this.searchBackend = options.searchBackend
      ?? createSearchBackend(resolveWebSearchConfig(config.webSearch));
    this.scheduleStore = new ScheduleStore(config.paths.schedulesDir ?? defaultSchedulesDir());
    // Closures, not bound methods: spies installed on this runtime later still apply.
    this.chat = new ChatTurns({
      loadedConfig: options.loadedConfig,
      environment: options.environment,
      engines: this.engines,
      sessionResolver: this.sessionResolver,
      memoryStore: this.memoryStore,
      searchBackend: () => this.searchBackend,
      resolveSettings: request => this.resolveSettings(request),
      assertSessionAvailable: (sessionId, owner) => this.assertSessionAvailable(sessionId, owner),
      memoryEnabled: (profile, requestMemories) => this.memoryEnabled(profile, requestMemories),
      memoryForRequest: (profile, requestMemories, prompt, thinking) => this.memoryForRequest(profile, requestMemories, prompt, thinking),
      resolveAgentConfigForProfile: profile => this.resolveAgentConfigForProfile(profile),
      resolveWebSearch: (settings, modelToolsEnabled) => this.resolveWebSearch(settings, modelToolsEnabled),
      fallbackWebSearchAvailable: (settings, modelToolsEnabled) => this.fallbackWebSearchAvailable(settings, modelToolsEnabled),
      providerToolsFor: (mode, nativeStrategy) => this.providerToolsFor(mode, nativeStrategy),
      replaceEditedExchange: (...args) => this.replaceEditedExchange(...args),
      missingEditedTurn: (sessionId, userTurnIndex) => this.missingEditedTurn(sessionId, userTurnIndex),
    });
    this.skillApps = new SkillAppOperations({
      loadedConfig: options.loadedConfig,
      engines: this.engines,
      createAppStore: directory => this.createAppStore(directory),
      resolveSettings: request => this.resolveSettings(request),
      memoryForRequest: (profile, requestMemories, prompt, thinking) => this.memoryForRequest(profile, requestMemories, prompt, thinking),
      resolveAgentConfigForProfile: profile => this.resolveAgentConfigForProfile(profile),
      createAgentRunner: (profile, registry, agentConfig, runtimeOptions) => this.createAgentRunner(profile, registry, agentConfig, runtimeOptions),
      listApps: () => this.listApps(),
      listProfiles: () => this.listProfiles(),
      listSkills: profile => this.listSkills(profile),
    });
  }

  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think' | 'maxContextTokens'>): MarifoldResolvedSettings {
    const { config, configPath } = this.options.loadedConfig;
    const profile = request.profile ?? config.default.profile;
    const profileSettings = this.profileResolver.loadSettings(profile);
    const provider = request.provider ?? profileSettings.provider ?? config.default.provider;
    const model = request.model ?? profileSettings.model ?? config.default.model;
    const think = request.think ?? profileSettings.think ?? config.default.think;
    const mode = profileSettings.mode ?? 'agent';
    if (!provider || !model) { throw MarifoldError.missingProviderModel(configPath); }
    return {
      profile, provider, model, think, mode,
      maxContextTokens: request.maxContextTokens ?? profileSettings.maxContextTokens,
      sessionContextTurns: profileSettings.sessionContextTurns,
    };
  }

  async ask(request: MarifoldRunRequest): Promise<MarifoldAskResponse> {
    return this.chat.ask(request);
  }

  stream(
    request: MarifoldRunRequest,
    onComplete?: (summary: { usage?: UsageInfo; latencyMs?: number }) => void,
    onReasoningSummary?: (text: string) => void,
  ): AsyncGenerator<string, void, unknown> {
    return this.chat.stream(request, onComplete, onReasoningSummary);
  }

  /** Run the selected web-search backend directly for non-chat integrations. */
  async searchWeb(query: string, maxResults?: number): Promise<string> {
    const config = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
    if (!config.enabled) { throw new Error('Web search is disabled.'); }
    const results = await this.searchBackend.search(query, maxResults ?? config.maxResults);
    return formatSearchResults(query, results);
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

  listMemories(profile: string, includeSuperseded = false): MemoryEntry[] {
    const entries = this.memoryStore.listEntries(profile);
    return includeSuperseded ? entries : entries.filter(entry => entry.status === 'active');
  }

  ensureProfileMemoryFiles(profile: string): MemoryScaffoldFile[] {
    this.profileResolver.load(profile);
    return this.memoryStore.ensureProfile(profile);
  }

  memoryEnabled(profile: string, requestMemories = true): boolean {
    return requestMemories && this.profileResolver.loadSettings(profile).memories;
  }

  listProfiles(): ProfileSummary[] {
    const activity = new Map(
      this.sessionResolver.profileActivity().map(item => [item.profileName, item]),
    );
    return this.profileResolver.list()
      .map(profile => {
        const recent = activity.get(profile.name);
        return recent ? {
          ...profile,
          ...(recent.pinned ? { pinned: true } : {}),
          ...(recent.updatedAt ? { updatedAt: recent.updatedAt } : {}),
          ...(recent.preview ? { preview: recent.preview } : {}),
        } : profile;
      })
      .sort((a, b) => {
        const pinOrder = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pinOrder !== 0) { return pinOrder; }
        const activityOrder = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
        return activityOrder !== 0 ? activityOrder : a.name.localeCompare(b.name);
      });
  }

  getProfile(name: string): ProfileDetail {
    return this.profileResolver.detail(name);
  }

  setProfilePinned(name: string, pinned: boolean): ProfileSummary[] {
    this.getProfile(name);
    this.sessionResolver.setProfilePinned(name, pinned);
    return this.listProfiles();
  }

  /** Persist (or clear) a profile's human-readable label. */
  setProfileDisplayName(name: string, displayName: string | undefined): void {
    this.profileManager.setDisplayName(name, displayName);
  }

  /** Persist a profile's default TUI mode to its profile.toml. Returns the
   * mode that was written. */
  setProfileMode(name: string, mode: ProfileMode): ProfileMode {
    return this.profileManager.setMode(name, mode).mode;
  }

  /** Persist (or clear) a profile's conversation-context budget in profile.toml. */
  setProfileMaxContextTokens(name: string, tokens: number | undefined): number | undefined {
    return this.profileManager.setMaxContextTokens(name, tokens).maxContextTokens;
  }

  /** Persist a per-profile approval decision into the profile's profile.toml
   * `[agent.approval]` (e.g. the TUI's "always allow"). `undefined` clears the
   * override so the kind inherits the global default again. */
  setProfileAgentApproval(name: string, kind: ToolKind, mode: ApprovalMode | undefined): void {
    this.profileManager.setAgentApproval(name, kind, mode);
  }

  /** Add a trusted folder capability to a profile. External folders still
   * require approval per action. Returns the resolved absolute folder. */
  addProfileTrustedFolder(name: string, folder: string): string {
    return this.profileManager.addTrustedFolder(name, folder).folder;
  }

  /** Remove a trusted folder from a profile. Returns whether it was present. */
  removeProfileTrustedFolder(name: string, folder: string): boolean {
    return this.profileManager.removeTrustedFolder(name, folder).removed;
  }

  /** Set (or clear with both undefined) a profile's provider/model override. */
  setProfileModelOverride(name: string, provider: string | undefined, model: string | undefined): void {
    if (provider === undefined && model === undefined) {
      this.profileManager.clearModelOverride(name);
      return;
    }
    if (!provider || !model) {
      throw MarifoldError.profileInvalid('Profile model overrides require both provider and model (or neither to clear).', name);
    }
    this.profileManager.setModelOverride(name, provider, model);
  }

  /** Persist (or clear) whether a profile loads its memory. */
  setProfileMemories(name: string, memories: boolean | undefined): void {
    this.profileManager.setMemories(name, memories);
  }

  /** Persist (or clear) a profile's thinking-mode default. */
  setProfileThink(name: string, think: boolean | undefined): void {
    this.profileManager.setThink(name, think);
  }

  /** Persist a profile's recent-turn window ('all'/undefined clears the key). */
  setProfileSessionContextTurns(name: string, turns: number | 'all' | undefined): void {
    this.profileManager.setSessionContextTurns(name, turns);
  }

  /** Overwrite the canonical profile instructions or a deprecated split-file alias. */
  writeProfileFile(name: string, file: ProfileFileKind, content: string): void {
    this.profileManager.writeProfileFile(name, file, content);
  }

  /** Consolidate a stored profile's legacy split instructions with backup. */
  migrateProfileInstructions(name: string): ProfileInstructionsMigrationResult {
    return this.profileManager.migrateProfileInstructions(name);
  }

  /** Scaffold a new profile directory (same layout as `profile init`) and
   * return its detail. Duplicate or invalid names throw PROFILE_INVALID. */
  initProfile(name: string): ProfileDetail {
    this.profileManager.init(name);
    return this.getProfile(name);
  }

  /** Delete stored profile files while retaining session history. The current
   * configured default must be changed first, matching the CLI guard. */
  deleteProfile(name: string): void {
    if (this.options.loadedConfig.config.default.profile === name) {
      throw MarifoldError.profileInvalid(
        `Cannot delete the current default profile '${name}'. Set another default profile first.`,
        name,
      );
    }
    this.profileManager.delete(name);
    this.sessionResolver.deleteProfileDisplay(name);
  }

  /** The profile's stored avatar image (path + media type), if any. */
  getProfileAvatar(name: string): { path: string; mediaType: string } | undefined {
    return this.profileManager.avatar(name);
  }

  /** Store a profile's avatar (PNG/JPEG/WebP, ≤1 MB), replacing any previous one. */
  setProfileAvatar(name: string, image: Buffer, mediaType: string): void {
    this.profileManager.setAvatar(name, image, mediaType);
  }

  /** Remove a profile's avatar. Returns whether one existed. */
  deleteProfileAvatar(name: string): boolean {
    return this.profileManager.deleteAvatar(name).removed;
  }

  /** Set a config value by dotted key and persist — the same routing and
   * validation as the CLI's `config set` (see ConfigManager.setValue). */
  setConfigValue(key: string, value: string): void {
    new ConfigManager(this.options.loadedConfig).setValue(key, value);
    if (key.startsWith('web_search.') && !this.searchBackendOverridden) {
      this.searchBackend = createSearchBackend(
        resolveWebSearchConfig(this.options.loadedConfig.config.webSearch),
      );
    }
  }

  /** Read a config value by dotted key (CLI `config get`). */
  getConfigValue(key: string): string | undefined {
    return new ConfigManager(this.options.loadedConfig).getValue(key);
  }

  /** Reachability + sanitized config for every provider (CLI `provider status`). */
  providerStatus(): Promise<ProviderStatus[]> {
    return new ProviderInspector(this.options.loadedConfig).status();
  }

  /** Models a provider actually serves right now (CLI `model list --live`). */
  async listProviderModels(provider: string): Promise<ProviderModelList> {
    try {
      await this.engines.refreshCredentials(provider);
    } catch (error) {
      return {
        provider,
        reachable: false,
        models: getProviderRegistryEntry(provider)?.knownModels ?? [],
        message: `${error instanceof Error ? error.message : String(error)} Showing registry models.`,
      };
    }
    return new ProviderInspector(this.options.loadedConfig).listModels(provider);
  }

  /** Add one registry provider for app clients. Existing entries must be
   * edited through the config surface so an accidental double-submit cannot
   * silently replace their connection settings. */
  addProvider(provider: string, options: ConfigAddProviderOptions = {}): void {
    if (this.options.loadedConfig.config.providers[provider]) {
      throw MarifoldError.configInvalid(`Provider '${provider}' is already configured.`);
    }
    new ConfigManager(this.options.loadedConfig).addProvider(provider, options);
  }

  /** Add a saved provider/model option (creating/updating the provider entry;
   * secrets are not part of this surface — CLI/file only). */
  addModelOption(provider: string, model: string, options: { type?: ProviderType; baseUrl?: string; apiKeyEnv?: string } = {}): void {
    new ConfigManager(this.options.loadedConfig).addModel(provider, model, options);
  }

  /** Remove a saved provider/model option. Returns whether it was present and
   * whether it was the current default (left untouched either way). */
  removeModelOption(provider: string, model: string): { removed: boolean; wasDefault: boolean } {
    const result = new ConfigManager(this.options.loadedConfig).removeModel(provider, model);
    return { removed: result.removed, wasDefault: result.wasDefault };
  }

  /** Remove local provider configuration and model options. Profile overrides
   * are guarded here because they live outside the global config file. */
  removeProvider(provider: string): { removed: boolean; removedModels: string[] } {
    const profileNames = this.listProfiles()
      .filter(profile => this.getProfile(profile.name).settings.provider === provider)
      .map(profile => profile.name);
    if (profileNames.length > 0) {
      throw MarifoldError.configInvalid(
        `Cannot remove provider '${provider}' because ${profileNames.length === 1 ? 'profile' : 'profiles'} `
        + `${profileNames.map(name => `'${name}'`).join(', ')} use it. Clear those model overrides first.`,
      );
    }
    const result = new ConfigManager(this.options.loadedConfig).removeProvider(provider);
    return { removed: result.removed, removedModels: result.removedModels };
  }

  /** Set the global default provider/model (also registers the option). */
  setDefaultModel(provider: string, model: string): void {
    new ConfigManager(this.options.loadedConfig).setDefaultModel(model, provider);
  }

  /** Supersede exactly one memory entry by id (per-row Forget — recoverable). */
  forgetMemoryById(profile: string, id: string): MemoryMutationResult {
    return this.memoryStore.forgetById(profile, id);
  }

  /** Permanently remove exactly one memory entry by id (per-row Delete). */
  deleteMemoryById(profile: string, id: string): MemoryMutationResult {
    return this.memoryStore.deleteById(profile, id);
  }

  /** Manually compact a session now (the /compact command). Returns whether anything was folded. */
  async compactSession(
    sessionId: string,
    request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think' | 'maxContextTokens'>,
  ): Promise<{ compacted: boolean }> {
    const settings = this.resolveSettings(request);
    await this.engines.refreshCredentials(settings.provider);
    const engine = this.engines.create(settings.provider, true);
    const result = await engine.compactSession(sessionId, this.engines.priestConfig(settings));
    return { compacted: result.compacted };
  }

  listSessions(limit?: number, profileName?: string, options?: SessionListOptions & { sessionOwner?: string }): SessionSummary[] {
    return this.sessionLeases.markInUse(this.sessionResolver.list(limit, profileName, options), options?.sessionOwner ?? this.sessionOwner);
  }

  /** Read-only integrity check of the session DB (for `marifold doctor`). Never throws. */
  checkSessionDb(): SessionDbHealth {
    return this.sessionResolver.checkIntegrity();
  }

  /** Filesystem path of the session DB, for diagnostics. */
  get sessionDbPath(): string {
    return this.options.loadedConfig.config.paths.sessionsDb;
  }

  latestSession(profileName?: string): SessionSummary | undefined {
    return this.sessionResolver.latest(profileName);
  }

  acquireSession(sessionId: string, owner: string = this.sessionOwner): void {
    this.sessionLeases.acquire(sessionId, owner);
  }

  takeOverSession(sessionId: string, owner: string = this.sessionOwner): void {
    this.sessionLeases.takeover(sessionId, owner);
  }

  releaseSession(sessionId: string, owner: string = this.sessionOwner): void {
    this.sessionLeases.release(sessionId, owner);
  }

  assertSessionAvailable(sessionId: string, owner: string = this.sessionOwner): void {
    this.sessionLeases.assertAvailable(sessionId, owner);
  }

  getSession(sessionId: string): SessionDetail | undefined {
    return this.sessionResolver.get(sessionId);
  }

  getSessionAttachment(
    sessionId: string,
    userTurnIndex: number,
    attachmentIndex: number,
  ): { mediaType: string; data?: string; url?: string; path?: string } | undefined {
    return this.sessionResolver.getAttachment(sessionId, userTurnIndex, attachmentIndex);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessionResolver.delete(sessionId);
  }

  updateSessionDisplay(sessionId: string, update: SessionDisplayUpdate): boolean {
    return this.sessionResolver.updateDisplay(sessionId, update);
  }

  truncateSessionFromUserTurn(sessionId: string, userTurnIndex: number): SessionTruncateResult {
    return this.sessionResolver.truncateFromUserTurn(sessionId, userTurnIndex);
  }

  clearSessions(options: { profileName?: string; before?: string; keepLast?: number } = {}): { count: number; ids: string[] } {
    return this.sessionResolver.clear(options);
  }

  renameSession(fromSessionId: string, toSessionId: string): boolean {
    return this.sessionResolver.rename(fromSessionId, toSessionId);
  }

  /**
   * Effective agent config for a profile: the global `[agent]` with the
   * profile's `[agent]` overrides (profile.toml) merged on top. Unset profile
   * keys inherit global/defaults; `undefined` profile → global only.
   */
  resolveAgentConfigForProfile(profile?: string): MarifoldAgentConfig {
    const global = resolveAgentConfig(this.options.loadedConfig.config.agent);
    const name = profile ?? this.options.loadedConfig.config.default.profile;
    const override = this.profileResolver.loadSettings(name).agent;
    if (!override) { return global; }
    const unattended = { ...(global.unattended ?? {}), ...(override.unattended ?? {}) };
    return {
      approval: { ...global.approval, ...(override.approval ?? {}) },
      ...(Object.keys(unattended).length > 0 ? { unattended } : {}),
      // Trusted folders are additive: a profile adds to any global ones.
      trustedFolders: [...new Set([...global.trustedFolders, ...(override.trustedFolders ?? [])])],
      maxIterations: override.maxIterations ?? global.maxIterations,
      toolOutputLimit: override.toolOutputLimit ?? global.toolOutputLimit,
      toolMode: override.toolMode ?? global.toolMode,
    };
  }

  /**
   * Build an approval-aware agent runner over this runtime's engine wiring,
   * TaskStore, and config policy. Pass a custom registry to replace the
   * default file/shell/delegate tool set.
   */
  createAgentRunner(
    profile?: string,
    registry?: ToolRegistry,
    agentConfigOverride?: MarifoldAgentConfig,
    runtimeOptions: {
      createWorkspace?: AgentRunnerDeps['createWorkspace'];
      listArtifacts?: AgentRunnerDeps['listArtifacts'];
      deviceInstructions?: string;
      contextInstructions?: string[];
      webSearch?: boolean;
      readOnlyFolders?: string[];
      readOnlyFiles?: string[];
      allowExternalReadOnlyFolders?: boolean;
    } = {},
  ): AgentRunner {
    return new AgentRunner({
      checkSession: options => { if (options.sessionId) { this.assertSessionAvailable(options.sessionId, options.sessionOwner); } },
      holdSession: options => options.sessionId
        ? this.sessionLeases.hold(options.sessionId, options.sessionOwner ?? this.sessionOwner)
        : undefined,
      environment: this.options.environment,
      deniedRoots: [path.join(path.dirname(this.options.loadedConfig.configPath), 'workspaces')],
      contextInstructions: runtimeOptions.contextInstructions,
      createWorkspace: runtimeOptions.createWorkspace,
      listArtifacts: runtimeOptions.listArtifacts,
      taskStore: this.taskStore,
      registry: registry ?? this.createDefaultToolRegistry(profile),
      agentConfig: agentConfigOverride ?? this.resolveAgentConfigForProfile(profile),
      resolveSettings: request => this.resolveSettings(request),
      prepareEngine: async settings => {
        await this.engines.refreshCredentials(settings.provider);
        const searchResolution = runtimeOptions.webSearch === false
          ? { mode: 'unavailable' as const, nativeStrategy: 'none' as const }
          : this.resolveWebSearch(settings);
        const webSearchMode = searchResolution.mode;
        return {
          // No engine-level session store: priest would otherwise persist the
          // raw per-iteration `Objective:`/tool framing (and duplicates). The
          // runner instead persists one clean turn pair via `persistTurn` below.
          engine: this.engines.create(settings.provider, false),
          config: this.engines.priestConfig(settings, searchResolution.nativeStrategy),
          webSearchMode,
          webSearchFallbackAvailable: webSearchMode === 'native'
            && this.fallbackWebSearchAvailable(settings),
          providerTools: this.providerToolsFor(webSearchMode, searchResolution.nativeStrategy),
        };
      },
      prepareImages: async (images, optimize) => (await prepareImageInputs(images, { optimize })).images,
      // Record the run as a tidy user→assistant exchange (the prompt when the
      // run starts, its outcome when it ends) so resuming the session shows the
      // result, not the agent's internal framing. Edits replace in one step.
      persistTurn: async (sessionId, profile, userText, assistantText, images, replaceUserTurnIndex, responseMetrics) => {
        if (replaceUserTurnIndex !== undefined) {
          this.replaceEditedExchange(sessionId, replaceUserTurnIndex, userText ?? '', assistantText ?? '', images, responseMetrics);
          return;
        }
        await this.sessionResolver.appendExchange(sessionId, profile, userText, assistantText, images, responseMetrics);
      },
      // Bounded cross-objective memory for non-lean tasks: replay the clean
      // pairs (objective → answer) that persistTurn wrote, never raw framing.
      loadRecentTurns: (sessionId, beforeUserTurnIndex) =>
        (beforeUserTurnIndex === undefined
          ? (this.sessionResolver.get(sessionId)?.turns ?? [])
          : (this.sessionResolver.turnsBeforeUserTurn(sessionId, beforeUserTurnIndex)
            ?? this.missingEditedTurn(sessionId, beforeUserTurnIndex)))
          .filter(t => t.role === 'user' || t.role === 'assistant')
          .map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
      resolveBuiltInInstructions: (objective, resolvedProfile) => {
        if (runtimeOptions.deviceInstructions) { return [runtimeOptions.deviceInstructions]; }
        const { config } = this.options.loadedConfig;
        if (mentionsSkillApps(objective)) {
          return [buildSkillAppBuilderGuide({
            profile: resolvedProfile,
            appsDir: config.paths.appsDir ?? defaultAppsDir(),
          })];
        }
        if (!mentionsSkills(objective)) { return []; }
        return [buildSkillManagerGuide({
          profile: resolvedProfile,
          profilesDir: config.paths.profilesDir,
          globalSkillsDir: config.paths.skillsDir ?? defaultSkillsDir(),
        })];
      },
      resolveReadOnlyFolders: resolvedProfile => {
        if (runtimeOptions.readOnlyFolders) { return runtimeOptions.readOnlyFolders; }
        const { config } = this.options.loadedConfig;
        return [
          path.join(config.paths.profilesDir, resolvedProfile, 'skills'),
          config.paths.skillsDir ?? defaultSkillsDir(),
        ];
      },
      resolveReadOnlyFiles: () => runtimeOptions.readOnlyFiles ?? [],
      allowExternalReadOnlyFolders: runtimeOptions.allowExternalReadOnlyFolders,
    });
  }

  createHostContextTools(profile?: string): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of this.createDefaultToolRegistry(profile).list()) {
      if (tool.kind === 'interaction' || ['web_search', 'read_web_page', 'delegate'].includes(tool.definition.name)) { registry.register(tool); }
    }
    return registry;
  }

  createDefaultToolRegistry(profile?: string): ToolRegistry {
    const registry = new ToolRegistry();
    const { config } = this.options.loadedConfig;
    const resolvedProfile = profile ?? config.default.profile;
    registry.register(new AskUserTool());
    registry.register(new InspectAttachmentTool());
    registry.register(new ReadAttachmentTool());
    registry.register(new SearchAttachmentTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    const deviceExecution = new DeviceExecution(this.options.loadedConfig.configPath);
    registry.register(new ShellExecTool(deviceExecution));
    registry.register(new SudoExecTool(deviceExecution));
    registry.register(new ShellJobStatusTool(deviceExecution));
    registry.register(new PythonPackageTool());
    registry.register(new SkillManagementTool({
      store: this.createSkillStore(resolvedProfile),
      profile: resolvedProfile,
      globalDir: config.paths.skillsDir ?? defaultSkillsDir(),
      profileDir: path.join(config.paths.profilesDir, resolvedProfile, 'skills'),
      profilesDir: config.paths.profilesDir,
      profileExists: profileName => this.listProfiles().some(candidate => candidate.name === profileName),
    }));
    registry.register(new SkillAppContextTool({
      activeProfile: resolvedProfile,
      appsDir: config.paths.appsDir ?? defaultAppsDir(),
      listApps: () => this.listApps().map(definition => definition.app),
      listProfiles: () => this.listProfiles(),
      listSkills: profileName => this.listSkills(profileName),
    }));
    registry.register(new SkillAppManagementTool({
      appsDir: config.paths.appsDir ?? defaultAppsDir(),
      createStore: appsDir => this.createAppStore(appsDir),
    }));
    // Marifold fallback web_search joins the registry when configured. Runs
    // with provider-hosted search filter it out before advertising tools.
    const webSearch = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
    const approval = this.resolveAgentConfigForProfile(profile).approval;
    if (webSearch.enabled && approval.network !== 'deny') {
      registry.register(new WebSearchTool(this.searchBackend, webSearch.maxResults));
      registry.register(new ReadWebPageTool(new WebPageReader({ proxy: webSearch.proxy })));
    }
    registry.register(new DelegateTool({
      ask: async request => {
        const response = await this.ask({ prompt: request.prompt, profile: request.profile });
        return { ok: response.ok, text: response.text, error: response.error };
      },
      listProfileNames: () => this.profileResolver.list().map(profile => profile.name),
    }));
    return registry;
  }

  /**
   * Skill store over the shared skills dir ([paths].skills_dir) and the given
   * profile's skills/ dir (profile skills shadow global ones). Defaults to the
   * configured default profile.
   */
  createSkillStore(profile?: string): SkillStore {
    const { config } = this.options.loadedConfig;
    const resolvedProfile = profile ?? config.default.profile;
    return new SkillStore({
      globalDir: config.paths.skillsDir ?? defaultSkillsDir(),
      profileDir: path.join(config.paths.profilesDir, resolvedProfile, 'skills'),
    });
  }

  listSkills(profile?: string, scope?: SkillScope): MarifoldSkill[] {
    const userSkills = this.createSkillStore(profile).list(scope);
    if (scope !== undefined) { return userSkills; }
    const byName = new Map(userSkills.map(skill => [skill.name, skill]));
    for (const skill of listBuiltInSkills()) { byName.set(skill.name, skill); }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(name: string, profile?: string): MarifoldSkill | undefined {
    return getBuiltInSkill(name) ?? this.createSkillStore(profile).get(name);
  }

  resolveSkillInvocation(input: string, profile?: string): ResolvedSkillInvocation {
    const parsed = parseSkillInvocation(input);
    if (!parsed) { throw MarifoldError.skillInvalid('Expected an invocation beginning with $.'); }
    const resolvedProfile = profile ?? this.options.loadedConfig.config.default.profile;
    this.profileResolver.loadSettings(resolvedProfile);
    const skill = getBuiltInSkill(parsed.name)
      ?? this.createSkillStore(resolvedProfile).require(parsed.name);
    return resolveSkillInvocationDefinition(skill, parsed);
  }

  installSkillFromText(text: string, scope: SkillScope = 'global', profile?: string): MarifoldSkill {
    return this.createSkillStore(profile).installFromText(text, scope);
  }

  installSkillFromFile(filePath: string, scope: SkillScope = 'global', profile?: string): MarifoldSkill {
    return this.createSkillStore(profile).installFromFile(filePath, scope);
  }

  removeSkill(name: string, profile?: string, scope?: SkillScope): boolean {
    return this.createSkillStore(profile).remove(name, scope);
  }

  createAppStore(directory?: string): AppStore {
    const { config } = this.options.loadedConfig;
    return new AppStore(directory ?? config.paths.appsDir ?? defaultAppsDir(), {
      resolveProfileSkill: (profile, skillName) => {
        this.profileResolver.load(profile);
        return getBuiltInSkill(skillName) ?? this.createSkillStore(profile).get(skillName);
      },
    });
  }

  listApps(): SkillAppDefinition[] {
    return this.createAppStore().list();
  }

  getApp(name: string): SkillAppDefinition | undefined {
    return this.createAppStore().get(name);
  }

  /** Execute one statically compiled SkillApp operation. v1 operations remain
   * profile-free; v2 profile operations load the referenced profile and may
   * receive read-only memory plus instance-local history. */
  async runSkillAppOperation(
    appName: string,
    operationName: string,
    state: Record<string, SkillAppStateValue>,
    signal?: AbortSignal,
    history?: SkillAppHistoryTurn[],
    attachments?: SkillAppAttachmentInput[],
    interactions?: SkillAppInteractionHandlers,
  ): Promise<SkillAppResult> {
    return this.skillApps.run(appName, operationName, state, signal, history, attachments, interactions);
  }

  createSkillAppInstanceRegistry(): SkillAppInstanceRegistry {
    return new SkillAppInstanceRegistry(this);
  }

  createSchedule(input: ScheduleCreateInput): ScheduleState {
    return this.scheduleStore.create(input);
  }

  listSchedules(): ScheduleState[] {
    return this.scheduleStore.list();
  }

  getSchedule(scheduleId: string): ScheduleState | undefined {
    return this.scheduleStore.get(scheduleId);
  }

  updateSchedule(scheduleId: string, input: ScheduleUpdateInput): ScheduleState {
    return this.scheduleStore.update(scheduleId, input);
  }

  deleteSchedule(scheduleId: string): boolean {
    return this.scheduleStore.delete(scheduleId);
  }

  /**
   * Execute one schedule unattended: [agent.unattended] approval overrides
   * apply and 'ask' degrades to deny. Records lastRunAt/lastTaskId.
   */
  async runScheduleUnattended(scheduleId: string): Promise<{ taskId?: string; status: string }> {
    const schedule = this.scheduleStore.require(scheduleId);
    const result = await this.runScheduledAgent(schedule);
    this.scheduleStore.update(schedule.id, {
      lastRunAt: new Date().toISOString(),
      ...(result.taskId ? { lastTaskId: result.taskId } : {}),
      lastResultSeen: false,
    });
    return result;
  }

  /** Scheduler for the long-running service process. Call start()/stop(). */
  createScheduler(log?: (message: string) => void): Scheduler {
    return new Scheduler({
      store: this.scheduleStore,
      runSchedule: schedule => this.runScheduledAgent(schedule),
      log,
    });
  }

  /** Telegram bridge for the service process, or undefined when not configured,
   * disabled, or missing a resolvable token. Call start()/stop(). */
  createTelegramBridge(log?: (message: string) => void): TelegramBridge | undefined {
    const config = this.options.loadedConfig.config.channels?.telegram;
    if (!config || config.enabled === false) { return undefined; }
    const token = config.botTokenEnv ? process.env[config.botTokenEnv] : config.botToken;
    if (!token) {
      log?.(`Telegram channel configured but no bot token resolved${config.botTokenEnv ? ` (env ${config.botTokenEnv} unset)` : ''} — bridge not started.`);
      return undefined;
    }
    return new TelegramBridge({
      runtime: this,
      token,
      config,
      log,
      profilesDir: this.options.loadedConfig.config.paths.profilesDir,
    });
  }

  /** Live run-session registry for the service process: start/attach/approve/
   * steer/cancel agent runs across separate requests. Call close() on shutdown. */
  createRunRegistry(log?: (message: string) => void, runnerForRun?: (input: RunStartInput) => AgentRunner | Promise<AgentRunner>, journal?: RunJournal): RunRegistry {
    return new RunRegistry({
      journal,
      runtime: {
        createAgentRunner: (profile, input) => runnerForRun && input ? runnerForRun(input) : this.createAgentRunner(profile),
        setProfileAgentApproval: (profile, kind, mode) => {
          this.setProfileAgentApproval(profile, kind, mode);
        },
        addProfileTrustedFolder: (profile, folder) => this.addProfileTrustedFolder(profile, folder),
        defaultProfile: () => this.options.loadedConfig.config.default.profile,
      },
      log,
    });
  }

  private async runScheduledAgent(schedule: ScheduleState): Promise<{ taskId?: string; status: string }> {
    const runner = this.createAgentRunner(schedule.profile);
    let taskId: string | undefined;
    let status = 'failed';
    for await (const event of runner.run({
      objective: schedule.objective,
      profile: schedule.profile,
      tags: ['scheduled'],
      unattended: true,
    })) {
      if (event.type === 'done') {
        taskId = event.taskId;
        status = event.status;
      }
    }
    return { taskId, status };
  }

  createTask(input: TaskCreateInput): TaskState {
    return this.taskStore.create(input);
  }

  listTasks(options: TaskListOptions = {}): TaskSummary[] {
    return this.taskStore.list(options);
  }

  getTask(taskId: string): TaskState | undefined {
    return this.taskStore.get(taskId);
  }

  updateTask(taskId: string, input: TaskUpdateInput): TaskState {
    return this.taskStore.update(taskId, input);
  }

  appendTaskEvent(taskId: string, input: TaskEventInput): TaskState {
    return this.taskStore.appendEvent(taskId, input);
  }

  deleteTask(taskId: string): boolean {
    return this.taskStore.delete(taskId);
  }

  close(): void {
    this.sessionLeases.close();
    this.sessionResolver.close();
  }

  /** Whether the profile's resolved provider honors thinking mode — so a channel
   * can tell the user when `/think` would have no effect. */
  profileSupportsThink(profile: string): boolean {
    const settings = this.resolveSettings({ profile });
    return this.engines.supportsThink(settings.provider, settings.model);
  }

  private memoryForRequest(profile: string, requestMemories = true, prompt = '', thinking = false): string[] {
    const { config } = this.options.loadedConfig;
    if (!this.memoryEnabled(profile, requestMemories)) { return []; }
    this.ensureProfileMemoryFiles(profile);
    return this.memoryStore.listPromptMemory(profile, {
      contextLimit: config.memory.contextLimit,
      prompt,
      thinking,
    });
  }

  private resolveWebSearch(
    settings: Pick<MarifoldResolvedSettings, 'profile' | 'provider' | 'model'>,
    modelToolsEnabled = true,
  ): { mode: MarifoldWebSearchMode; nativeStrategy: NativeWebSearchStrategy } {
    if (!modelToolsEnabled || !resolveWebSearchConfig(this.options.loadedConfig.config.webSearch).enabled) {
      return { mode: 'unavailable', nativeStrategy: 'none' };
    }
    const approval = this.resolveAgentConfigForProfile(settings.profile).approval;
    if (approval.network === 'deny') {
      return { mode: 'unavailable', nativeStrategy: 'none' };
    }
    const nativeStrategy = this.providerFactory.nativeWebSearchStrategy(settings.provider, settings.model);
    if (nativeStrategy !== 'none') {
      return { mode: 'native', nativeStrategy };
    }
    return {
      mode: this.fallbackWebSearchAvailable(settings, modelToolsEnabled) ? 'fallback' : 'unavailable',
      nativeStrategy: 'none',
    };
  }

  private fallbackWebSearchAvailable(
    settings: Pick<MarifoldResolvedSettings, 'profile'>,
    modelToolsEnabled = true,
  ): boolean {
    if (!modelToolsEnabled) {
      return false;
    }
    const approval = this.resolveAgentConfigForProfile(settings.profile).approval;
    return approval.network !== 'deny'
      && resolveWebSearchConfig(this.options.loadedConfig.config.webSearch).enabled;
  }

  private providerToolsFor(
    mode: MarifoldWebSearchMode,
    nativeStrategy: NativeWebSearchStrategy,
  ): MarifoldProviderToolDefinition[] | undefined {
    return mode === 'native' && nativeStrategy === 'responses-tool'
      ? [{ type: 'web_search' }]
      : undefined;
  }

  private replaceEditedExchange(
    sessionId: string,
    userTurnIndex: number,
    userText: string,
    assistantText: string,
    images?: ImageInput[],
    responseMetrics?: ResponseMetrics,
  ): void {
    const result = this.sessionResolver.replaceExchange(
      sessionId,
      userTurnIndex,
      userText,
      assistantText,
      images,
      responseMetrics,
    );
    if (!result.replaced) { this.missingEditedTurn(sessionId, userTurnIndex); }
  }

  private missingEditedTurn(sessionId: string, userTurnIndex: number): never {
    throw MarifoldError.configInvalid(
      `Cannot edit user turn ${userTurnIndex} because it is missing from session '${sessionId}'.`,
    );
  }

}
