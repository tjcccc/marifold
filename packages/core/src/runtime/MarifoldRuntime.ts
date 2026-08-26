import { ImageInput, JSONValue, PriestConfig, PriestEngine, PriestRequest, PriestResponse, ToolDefinition, ToolExchangeTurn, UsageInfo } from '@priest-ai/core';
import * as path from 'path';
import { AgentRunner } from '../agent/AgentRunner';
import { buildHistoryContext } from '../agent/AgentHistory';
import { ApprovalMode, MarifoldAgentConfig, ToolKind, resolveAgentConfig } from '../agent/ApprovalPolicy';
import { DelegateTool } from '../agent/tools/DelegateTool';
import { PythonPackageTool } from '../agent/tools/PythonPackageTool';
import { ReadAttachmentTool } from '../agent/tools/ReadAttachmentTool';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { SearchAttachmentTool } from '../agent/tools/SearchAttachmentTool';
import { ShellExecTool } from '../agent/tools/ShellExecTool';
import { WebSearchTool } from '../agent/tools/WebSearchTool';
import { AskUserTool } from '../agent/tools/AskUserTool';
import { InspectAttachmentTool } from '../agent/tools/InspectAttachmentTool';
import { WriteFileTool } from '../agent/tools/WriteFileTool';
import { AgentTool, ToolRegistry } from '../agent/ToolRegistry';
import { ChatGptRefreshedTokens, refreshChatGptAccessToken } from '../config/ChatGptTokenRefresh';
import { XaiRefreshedTokens, refreshXaiAccessToken } from '../config/XaiTokenRefresh';
import { ConfigManager } from '../config/ConfigManager';
import type { ConfigAddProviderOptions } from '../config/ConfigManager';
import { LoadedMarifoldConfig, ProfileDetail, ProfileMode, ProfileSummary, ProviderType, resolveWebSearchConfig, SessionDetail, SessionSummary } from '../config/ConfigSchema';
import { ProviderInspector } from '../config/ProviderInspector';
import type { ProviderModelList, ProviderStatus } from '../config/ProviderInspector';
import { exchangeGitHubTokenForCopilotToken } from '../config/GitHubCopilotAuth';
import { createSearchBackend } from '../search/createSearchBackend';
import { formatSearchResults, SearchBackend } from '../search/SearchBackend';
import { ProviderFactory } from '../config/ProviderFactory';
import { isGitHubCopilotResponsesModelId } from '../config/ProviderRegistry';
import { MarifoldError } from '../errors/MarifoldError';
import { prepareImageInputs } from '../images/ImageOptimizer';
import { MemoryStore } from '../memory/MemoryStore';
import type { MemoryEntry, MemoryKind, MemoryMutationResult, MemoryRememberResult, MemoryScaffoldFile } from '../memory/MemoryStore';
import {
  MemoryControlStripper,
  buildMemoryInstructions,
  extractPromptForgetQueries,
  extractPromptMemoryInputs,
  shouldInjectMemoryInstructions,
  stripMemoryControls,
} from '../memory/MemoryControls';
import type { MemoryControlPayloads } from '../memory/MemoryControls';
import { ProfileResolver } from '../profiles/ProfileResolver';
import { ProfileManager } from '../profiles/ProfileManager';
import type { ProfileFileKind } from '../profiles/ProfileManager';
import { Scheduler } from '../schedule/Scheduler';
import { RunRegistry } from '../runs/RunRegistry';
import { TelegramBridge } from '../channels/TelegramBridge';
import { ScheduleCreateInput, ScheduleState, ScheduleStore, ScheduleUpdateInput } from '../schedule/ScheduleStore';
import {
  SessionResolver,
  SessionDbHealth,
  SessionDisplayUpdate,
  SessionListOptions,
  SessionTruncateResult,
} from '../sessions/SessionResolver';
import type { ResponseMetrics } from '../sessions/ResponseMetrics';
import { SkillStore } from '../skill/SkillStore';
import { MarifoldSkill } from '../skill/SkillSchema';
import { SkillScope } from '../skill/SkillStore';
import {
  parseSkillInvocation,
  resolveSkillInvocation as resolveSkillInvocationDefinition,
} from '../skill/SkillInvocation';
import type { ResolvedSkillInvocation } from '../skill/SkillInvocation';
import { buildSkillManagerGuide, mentionsSkills } from '../skill/BuiltInSkillManager';
import { AppStore } from '../app/AppStore';
import { resolveSkillAppOperation as resolveSkillAppOperationDefinition } from '../app/SkillAppResolver';
import type { SkillAppDefinition, SkillAppResult, SkillAppStateValue } from '../app/SkillAppSchema';
import { SkillAppInstanceRegistry } from '../app/SkillAppInstanceRegistry';
import { TaskStore } from '../tasks/TaskStore';
import { defaultAppsDir, defaultSchedulesDir, defaultSkillsDir } from '../workspace/WorkspacePaths';
import type { TaskCreateInput, TaskEventInput, TaskListOptions, TaskState, TaskSummary, TaskUpdateInput } from '../tasks/TaskStore';
import { MarifoldAskResponse, MarifoldProviderToolDefinition, MarifoldResolvedSettings, MarifoldRunRequest, MarifoldWebSearchMode } from './MarifoldTypes';

// Older OpenAI-compatible gateways still take a raw `{think}` body option.
// Priest 2.8 owns neutral reasoning for Ollama, Anthropic, and Responses.
const LEGACY_THINK_PROVIDER_NAMES = new Set(['bailian', 'alibaba_cloud']);
const CHAT_TOOL_MAX_ITERATIONS = 3;
const EDIT_HISTORY_BUDGET_DEFAULT_CHARS = 16_000;
const NATIVE_WEB_SEARCH_COMPAT_OPTION = 'marifold_native_web_search';
const WEB_SEARCH_UNAVAILABLE_CONTEXT = 'Web search is unavailable for this run. If the user asks you to browse or search the web, or their question requires current information, say clearly that you cannot access web search; do not imply that you searched.';

export interface MarifoldRuntimeOptions {
  loadedConfig: LoadedMarifoldConfig;
  /** Override the web search backend (tests, alternative engines). */
  searchBackend?: SearchBackend;
}

export class MarifoldRuntime {
  private readonly profileResolver: ProfileResolver;
  private readonly profileManager: ProfileManager;
  private readonly sessionResolver: SessionResolver;
  private readonly providerFactory: ProviderFactory;
  private readonly memoryStore: MemoryStore;
  private readonly taskStore: TaskStore;
  private readonly searchBackend: SearchBackend;
  private readonly scheduleStore: ScheduleStore;

  constructor(private readonly options: MarifoldRuntimeOptions) {
    const { config, configPath } = options.loadedConfig;
    this.profileResolver = new ProfileResolver(config.paths.profilesDir);
    this.profileManager = new ProfileManager(config.paths.profilesDir);
    this.sessionResolver = new SessionResolver(config.paths.sessionsDb);
    this.providerFactory = new ProviderFactory(config, configPath);
    this.memoryStore = new MemoryStore(config.paths.profilesDir);
    this.taskStore = new TaskStore(config.paths.tasksDir);
    this.searchBackend = options.searchBackend
      ?? createSearchBackend(resolveWebSearchConfig(config.webSearch));
    this.scheduleStore = new ScheduleStore(config.paths.schedulesDir ?? defaultSchedulesDir());
  }

  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think' | 'maxContextTokens'>): MarifoldResolvedSettings {
    const { config, configPath } = this.options.loadedConfig;
    const profile = request.profile ?? config.default.profile;
    const profileSettings = this.profileResolver.loadSettings(profile);
    const provider = request.provider ?? profileSettings.provider ?? config.default.provider;
    const model = request.model ?? profileSettings.model ?? config.default.model;
    const think = request.think ?? profileSettings.think ?? config.default.think;
    const mode = profileSettings.mode ?? 'agent';
    if (!provider || !model) throw MarifoldError.missingProviderModel(configPath);
    return {
      profile, provider, model, think, mode,
      maxContextTokens: request.maxContextTokens ?? profileSettings.maxContextTokens,
      sessionContextTurns: profileSettings.sessionContextTurns,
    };
  }

  async ask(request: MarifoldRunRequest): Promise<MarifoldAskResponse> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const settings = this.resolveSettings(request);
    const preparedImages = await prepareImageInputs(request.images, { optimize: request.originalImages !== true });
    await this.refreshProviderCredentialsIfNeeded(settings.provider);
    const replacing = request.replaceUserTurnIndex !== undefined;
    const isolated = request.isolated === true;
    const engine = this.createEngine(
      settings.provider,
      Boolean(request.sessionId) && !replacing && !isolated,
      request.profileContext !== false,
    );
    const memoryOn = this.memoryEnabled(settings.profile, request.memories);
    const memory = this.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const webSearchMode = this.resolveWebSearchMode(settings, request.chatTools !== false);
    const chatTools = this.chatTools(request, webSearchMode);
    const priestRequest: PriestRequest & { providerTools?: MarifoldProviderToolDefinition[] } = {
      config: this.toPriestConfig(settings, webSearchMode === 'native'),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId && !replacing && !isolated
        ? { id: request.sessionId, createIfMissing: true }
        : undefined,
      context: [
        ...this.runtimeContext(memory, request.prompt, memoryOn, webSearchMode),
        ...this.editHistoryContext(request, settings),
        ...(request.instructions ?? []),
      ],
      memory,
      images: preparedImages.images.length > 0 ? preparedImages.images : undefined,
      userContext: request.userContext,
      providerTools: this.providerToolsFor(webSearchMode),
    };
    const exchange: ToolExchangeTurn[] = [];
    const maxIterations = chatTools ? CHAT_TOOL_MAX_ITERATIONS : 1;
    let response: PriestResponse | undefined;
    let aggregateUsage: UsageInfo | undefined;

    // Keep the non-streaming CLI/service path at parity with stream(): a model
    // without hosted search can call Marifold's configured fallback, then see
    // the turn-local result before producing its final answer.
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const lastIteration = iteration === maxIterations - 1;
      response = await engine.run({
        ...priestRequest,
        ...(chatTools && !lastIteration ? { tools: chatTools.definitions } : {}),
        ...(exchange.length > 0 ? { toolExchange: exchange } : {}),
      }, request.signal ? { signal: request.signal } : undefined);
      aggregateUsage = sumUsage(aggregateUsage, response.usage);
      if (!response.ok || !chatTools || !response.toolCalls?.length) break;

      exchange.push({
        kind: 'assistant',
        text: response.text,
        toolCalls: response.toolCalls,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
      });
      for (const call of response.toolCalls) {
        const result = await chatTools.execute(call.name, call.arguments);
        exchange.push({
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: result.content,
          isError: result.isError,
        });
      }
    }

    // maxIterations is clamped above and therefore always produces a response.
    const finalResponse = response!;
    const stripped = stripMemoryControls(finalResponse.text ?? '');
    const userTurn = request.userTurn ?? request.prompt;
    const responseMetrics = completedResponseMetrics(
      'chat',
      settings,
      startedAt,
      startedAtMs,
      aggregateUsage,
    );
    if (finalResponse.ok && request.sessionId) {
      if (request.replaceUserTurnIndex !== undefined) {
        this.replaceEditedExchange(
          request.sessionId,
          request.replaceUserTurnIndex,
          userTurn,
          stripped.text,
          preparedImages.images,
          responseMetrics,
        );
      } else if (isolated) {
        await this.sessionResolver.appendExchange(
          request.sessionId,
          settings.profile,
          userTurn,
          stripped.text,
          preparedImages.images,
          responseMetrics,
        );
      } else {
        if (request.userTurn) this.sessionResolver.replaceLastUserTurn(request.sessionId, request.userTurn);
        this.sessionResolver.replaceLastAssistantTurn(request.sessionId, stripped.text);
        this.sessionResolver.saveLastUserTurnAttachments(request.sessionId, preparedImages.images);
        this.sessionResolver.saveLastResponseMetrics(request.sessionId, responseMetrics);
      }
    }
    if (finalResponse.ok && memoryOn) {
      this.applyTurnMemory(settings.profile, request.prompt, stripped, request.sessionId);
    }

    return {
      ok: finalResponse.ok,
      text: stripped.text,
      settings,
      latencyMs: finalResponse.ok ? responseMetrics.latencyMs : finalResponse.execution.latencyMs,
      session: finalResponse.session,
      error: finalResponse.error
        ? { code: finalResponse.error.code, message: finalResponse.error.message }
        : undefined,
    };
  }

  async *stream(
    request: MarifoldRunRequest,
    onComplete?: (summary: { usage?: UsageInfo; latencyMs?: number }) => void,
    onReasoningSummary?: (text: string) => void,
  ): AsyncGenerator<string, void, unknown> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const settings = this.resolveSettings(request);
    const preparedImages = await prepareImageInputs(request.images, { optimize: request.originalImages !== true });
    await this.refreshProviderCredentialsIfNeeded(settings.provider);
    let aggregateUsage: UsageInfo | undefined;
    const replacing = request.replaceUserTurnIndex !== undefined;
    const isolated = request.isolated === true;
    const enginePersistsSession = Boolean(request.sessionId) && !replacing && !isolated;
    const sessionWasMissing = enginePersistsSession
      ? this.sessionResolver.get(request.sessionId!) === undefined
      : false;
    const engine = this.createEngine(
      settings.provider,
      enginePersistsSession,
      request.profileContext !== false,
    );
    const memoryOn = this.memoryEnabled(settings.profile, request.memories);
    const memory = this.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const webSearchMode = this.resolveWebSearchMode(settings, request.chatTools !== false);
    const chatTools = this.chatTools(request, webSearchMode);

    const baseRequest: PriestRequest & { providerTools?: MarifoldProviderToolDefinition[] } = {
      config: this.toPriestConfig(settings, webSearchMode === 'native'),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId && !replacing && !isolated
        ? { id: request.sessionId, createIfMissing: true }
        : undefined,
      context: [
        ...this.runtimeContext(memory, request.prompt, memoryOn, webSearchMode),
        ...this.editHistoryContext(request, settings),
        ...(request.instructions ?? []),
      ],
      memory,
      images: preparedImages.images.length > 0 ? preparedImages.images : undefined,
      userContext: request.userContext,
      providerTools: this.providerToolsFor(webSearchMode),
    };

    // Caller-executed fallback/read loop. Provider-hosted search is carried
    // separately and does not enter Marifold's tool exchange.
    // Intermediate tool-call turns are turn-local; the engine persists the
    // session only on the loop's final response, and memory payloads are
    // applied only from that final response.
    const exchange: ToolExchangeTurn[] = [];
    const maxIterations = chatTools ? CHAT_TOOL_MAX_ITERATIONS : 1;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const stripper = new MemoryControlStripper();
      const visibleParts: string[] = [];
      let done: PriestResponse | undefined;
      const lastIteration = iteration === maxIterations - 1;

      for await (const event of engine.streamEvents(
        {
          ...baseRequest,
          ...(chatTools && !lastIteration ? { tools: chatTools.definitions } : {}),
          ...(exchange.length > 0 ? { toolExchange: exchange } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      )) {
        if (event.type === 'text_delta') {
          const visible = stripper.feed(event.text);
          if (visible) {
            visibleParts.push(visible);
            yield visible;
          }
        } else if (event.type === 'reasoning_summary_delta') {
          onReasoningSummary?.(event.text);
        } else if (event.type === 'done') {
          done = event.response;
        }
      }
      const tail = stripper.flush();
      if (tail) {
        visibleParts.push(tail);
        yield tail;
      }

      aggregateUsage = sumUsage(aggregateUsage, done?.usage);
      if (done?.error) {
        this.discardFailedNewSession(request.sessionId, sessionWasMissing);
        throw MarifoldError.providerError(
          done.error.message,
          settings.provider,
          settings.model,
          done.error.code,
        );
      }
      const toolCalls = done?.toolCalls ?? [];
      if (!chatTools || toolCalls.length === 0) {
        const streamedText = visibleParts.join('');
        const fallbackControls = streamedText.length === 0
          ? stripMemoryControls(done?.text ?? '')
          : undefined;
        const finalText = streamedText || fallbackControls?.text || '';
        if (done?.text === undefined && finalText.length === 0) {
          this.discardFailedNewSession(request.sessionId, sessionWasMissing);
          throw MarifoldError.providerError(
            `Provider '${settings.provider}' returned no text for model '${settings.model}'.`,
            settings.provider,
            settings.model,
            'EMPTY_RESPONSE',
          );
        }
        if (streamedText.length === 0 && finalText) yield finalText;
        const userTurn = request.userTurn ?? request.prompt;
        const responseMetrics = completedResponseMetrics(
          'chat',
          settings,
          startedAt,
          startedAtMs,
          aggregateUsage,
        );
        if (request.sessionId) {
          if (request.replaceUserTurnIndex !== undefined) {
            this.replaceEditedExchange(
              request.sessionId,
              request.replaceUserTurnIndex,
              userTurn,
              finalText,
              preparedImages.images,
              responseMetrics,
            );
          } else if (isolated) {
            await this.sessionResolver.appendExchange(
              request.sessionId,
              settings.profile,
              userTurn,
              finalText,
              preparedImages.images,
              responseMetrics,
            );
          } else {
            if (request.userTurn) this.sessionResolver.replaceLastUserTurn(request.sessionId, request.userTurn);
            this.sessionResolver.replaceLastAssistantTurn(request.sessionId, finalText);
            this.sessionResolver.saveLastUserTurnAttachments(request.sessionId, preparedImages.images);
            this.sessionResolver.saveLastResponseMetrics(request.sessionId, responseMetrics);
          }
        }
        if (memoryOn) {
          this.applyTurnMemory(
            settings.profile,
            request.prompt,
            fallbackControls ?? stripper,
            request.sessionId,
          );
        }
        onComplete?.({ usage: aggregateUsage, latencyMs: responseMetrics.latencyMs });
        return;
      }

      exchange.push({
        kind: 'assistant',
        text: done?.text,
        toolCalls,
        ...(done?.reasoning ? { reasoning: done.reasoning } : {}),
      });
      for (const call of toolCalls) {
        const result = await chatTools.execute(call.name, call.arguments);
        exchange.push({
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: result.content,
          isError: result.isError,
        });
      }
    }
  }

  /** Run the web search backend directly (the /search chat command). */
  async searchWeb(query: string, maxResults?: number): Promise<string> {
    const config = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
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
        if (pinOrder !== 0) return pinOrder;
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

  /** Overwrite one of a profile's markdown files (PROFILE/RULES/CUSTOM.md). */
  writeProfileFile(name: string, file: ProfileFileKind, content: string): void {
    this.profileManager.writeProfileFile(name, file, content);
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
  listProviderModels(provider: string): Promise<ProviderModelList> {
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
    await this.refreshProviderCredentialsIfNeeded(settings.provider);
    const engine = this.createEngine(settings.provider, true);
    const result = await engine.compactSession(sessionId, this.toPriestConfig(settings));
    return { compacted: result.compacted };
  }

  listSessions(limit?: number, profileName?: string, options?: SessionListOptions): SessionSummary[] {
    return this.sessionResolver.list(limit, profileName, options);
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

  getSession(sessionId: string): SessionDetail | undefined {
    return this.sessionResolver.get(sessionId);
  }

  getSessionAttachment(
    sessionId: string,
    userTurnIndex: number,
    attachmentIndex: number,
  ): { mediaType: string; data?: string; url?: string } | undefined {
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
   * Build an approval-aware agent runner over this runtime's engine wiring,
   * TaskStore, and config policy. Pass a custom registry to replace the
   * default file/shell/delegate tool set.
   */
  /**
   * Effective agent config for a profile: the global `[agent]` with the
   * profile's `[agent]` overrides (profile.toml) merged on top. Unset profile
   * keys inherit global/defaults; `undefined` profile → global only.
   */
  resolveAgentConfigForProfile(profile?: string): MarifoldAgentConfig {
    const global = resolveAgentConfig(this.options.loadedConfig.config.agent);
    const name = profile ?? this.options.loadedConfig.config.default.profile;
    const override = this.profileResolver.loadSettings(name).agent;
    if (!override) return global;
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

  createAgentRunner(profile?: string, registry?: ToolRegistry): AgentRunner {
    return new AgentRunner({
      taskStore: this.taskStore,
      registry: registry ?? this.createDefaultToolRegistry(profile),
      agentConfig: this.resolveAgentConfigForProfile(profile),
      resolveSettings: request => this.resolveSettings(request),
      prepareEngine: async settings => {
        await this.refreshProviderCredentialsIfNeeded(settings.provider);
        const webSearchMode = this.resolveWebSearchMode(settings);
        return {
          // No engine-level session store: priest would otherwise persist the
          // raw per-iteration `Objective:`/tool framing (and duplicates). The
          // runner instead persists one clean turn pair via `persistTurn` below.
          engine: this.createEngine(settings.provider, false),
          config: this.toPriestConfig(settings, webSearchMode === 'native'),
          webSearchMode,
          providerTools: this.providerToolsFor(webSearchMode),
        };
      },
      prepareImages: async (images, optimize) => (await prepareImageInputs(images, { optimize })).images,
      // Record the run as a single tidy user→assistant exchange so resuming the
      // session shows the result, not the agent's internal framing.
      persistTurn: async (
        sessionId,
        profile,
        userText,
        assistantText,
        images,
        replaceUserTurnIndex,
        responseMetrics,
      ) => {
        if (replaceUserTurnIndex !== undefined) {
          this.replaceEditedExchange(
            sessionId,
            replaceUserTurnIndex,
            userText,
            assistantText,
            images,
            responseMetrics,
          );
          return;
        }
        await this.sessionResolver.appendExchange(
          sessionId,
          profile,
          userText,
          assistantText,
          images,
          responseMetrics,
        );
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
        if (!mentionsSkills(objective)) return [];
        const { config } = this.options.loadedConfig;
        return [buildSkillManagerGuide({
          profile: resolvedProfile,
          profilesDir: config.paths.profilesDir,
          globalSkillsDir: config.paths.skillsDir ?? defaultSkillsDir(),
        })];
      },
      resolveReadOnlyFolders: resolvedProfile => {
        const { config } = this.options.loadedConfig;
        return [
          path.join(config.paths.profilesDir, resolvedProfile, 'skills'),
          config.paths.skillsDir ?? defaultSkillsDir(),
        ];
      },
    });
  }

  private createDefaultToolRegistry(profile?: string): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(new AskUserTool());
    registry.register(new InspectAttachmentTool());
    registry.register(new ReadAttachmentTool());
    registry.register(new SearchAttachmentTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new ShellExecTool());
    registry.register(new PythonPackageTool());
    // Marifold fallback web_search joins the registry when configured. Runs
    // with provider-hosted search filter it out before advertising tools.
    const webSearch = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
    const approval = this.resolveAgentConfigForProfile(profile).approval;
    if (webSearch.enabled && approval.network !== 'deny') {
      registry.register(new WebSearchTool(this.searchBackend, webSearch.maxResults));
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
    return this.createSkillStore(profile).list(scope);
  }

  getSkill(name: string, profile?: string): MarifoldSkill | undefined {
    return this.createSkillStore(profile).get(name);
  }

  resolveSkillInvocation(input: string, profile?: string): ResolvedSkillInvocation {
    const parsed = parseSkillInvocation(input);
    if (!parsed) throw MarifoldError.skillInvalid('Expected an invocation beginning with $.');
    const resolvedProfile = profile ?? this.options.loadedConfig.config.default.profile;
    this.profileResolver.loadSettings(resolvedProfile);
    const skill = this.createSkillStore(resolvedProfile).require(parsed.name);
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

  createAppStore(): AppStore {
    const { config } = this.options.loadedConfig;
    return new AppStore(config.paths.appsDir ?? defaultAppsDir());
  }

  listApps(): SkillAppDefinition[] {
    return this.createAppStore().list();
  }

  getApp(name: string): SkillAppDefinition | undefined {
    return this.createAppStore().get(name);
  }

  /** Execute one profile-free v1 operation and normalize provider output to
   * the Skill's declared result contract. No session, memory, tools, profile
   * context, or transcript is created. */
  async runSkillAppOperation(
    appName: string,
    operationName: string,
    state: Record<string, SkillAppStateValue>,
    signal?: AbortSignal,
  ): Promise<SkillAppResult> {
    const startedAt = Date.now();
    try {
      const store = this.createAppStore();
      const definition = store.require(appName);
      const operation = resolveSkillAppOperationDefinition(
        store,
        definition,
        operationName,
        state,
      );
      await this.refreshProviderCredentialsIfNeeded(operation.model.provider);
      const settings: MarifoldResolvedSettings = {
        profile: `skillapp-${appName}`,
        provider: operation.model.provider,
        model: operation.model.model,
        think: operation.model.think,
        mode: 'chat',
      };
      const response = await this.createEngine(settings.provider, false, false).run({
        config: this.toPriestConfig(settings),
        profile: settings.profile,
        prompt: operation.prompt,
        context: operation.instructions,
      }, signal ? { signal } : undefined);
      if (response.error) {
        throw MarifoldError.providerError(
          response.error.message,
          settings.provider,
          settings.model,
          response.error.code,
        );
      }
      if (response.text === undefined) {
        throw MarifoldError.providerError(
          `Provider '${settings.provider}' returned no text for model '${settings.model}'.`,
          settings.provider,
          settings.model,
          'EMPTY_RESPONSE',
        );
      }
      const text = operation.result.trim ? response.text.trim() : response.text;
      return {
        status: 'ok',
        data: { text },
        meta: {
          engine: settings.provider,
          model: settings.model,
          durationMs: Date.now() - startedAt,
          ...(response.usage ? { usage: response.usage } : {}),
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        status: 'error',
        error: {
          code: error instanceof MarifoldError ? error.code : 'APP_INVALID',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
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
    if (!config || config.enabled === false) return undefined;
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
  createRunRegistry(log?: (message: string) => void): RunRegistry {
    return new RunRegistry({
      runtime: {
        createAgentRunner: profile => this.createAgentRunner(profile),
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
    this.sessionResolver.close();
  }

  private discardFailedNewSession(sessionId: string | undefined, sessionWasMissing: boolean): void {
    if (!sessionId || !sessionWasMissing) return;
    const session = this.sessionResolver.get(sessionId);
    if (session?.turnCount === 0) this.sessionResolver.delete(sessionId);
  }

  private createEngine(providerName: string, useSession: boolean, profileContext = true): PriestEngine {
    const adapter = this.providerFactory.create(providerName);
    const profileLoader = profileContext
      ? this.profileResolver
      : {
          load: (name: string) => ({
            name,
            identity: '',
            rules: '',
            custom: '',
            memories: [],
          }),
        };
    return new PriestEngine(
      profileLoader,
      useSession ? this.sessionResolver.openStore() : undefined,
      { [providerName]: adapter },
    );
  }

  private async refreshProviderCredentialsIfNeeded(providerName: string): Promise<void> {
    if (providerName !== 'github_copilot' && providerName !== 'chatgpt' && providerName !== 'xai') return;

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

    if (providerName === 'github_copilot') {
      try {
        const refreshed = await exchangeGitHubTokenForCopilotToken(provider.oauthToken);
        provider.apiKey = refreshed.token;
        provider.baseUrl = refreshed.baseUrl;
        provider.apiKeyExpiresAt = refreshed.expiresAt;
        new ConfigManager(this.options.loadedConfig).save();
      } catch (error) {
        throw MarifoldError.configInvalid(
          `GitHub Copilot authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Run marifold provider reauth github_copilot to authorize again.`,
        );
      }
      return;
    }

    if (providerName === 'xai') {
      try {
        const refreshed: XaiRefreshedTokens = await refreshXaiAccessToken(provider.oauthToken, provider.proxy);
        provider.apiKey = refreshed.apiKey;
        provider.oauthToken = refreshed.refreshToken;
        provider.apiKeyExpiresAt = refreshed.expiresAt;
        new ConfigManager(this.options.loadedConfig).save();
      } catch (error) {
        throw MarifoldError.configInvalid(
          `xAI authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Run marifold provider reauth xai to sign in again.`,
        );
      }
      return;
    }

    // chatgpt: refresh the API credential from the stored OAuth refresh token.
    // ChatGPT credentials without an apiKeyExpiresAt were issued before
    // refresh support and may still be valid — only refresh when expiry is
    // known or the key is missing.
    if (provider.apiKey && provider.apiKeyExpiresAt === undefined) return;
    try {
      const refreshed: ChatGptRefreshedTokens = await refreshChatGptAccessToken(provider.oauthToken);
      provider.apiKey = refreshed.apiKey;
      provider.oauthToken = refreshed.refreshToken;
      provider.apiKeyExpiresAt = refreshed.expiresAt;
      if (refreshed.accountId) provider.accountId = refreshed.accountId;
      new ConfigManager(this.options.loadedConfig).save();
    } catch (error) {
      throw MarifoldError.configInvalid(
        `ChatGPT authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Run marifold provider reauth chatgpt to sign in again.`,
      );
    }
  }

  /** Caller-executed tools for chat turns. Marifold web_search is advertised
   * only in fallback mode; provider-hosted search travels separately. */
  private chatTools(request: MarifoldRunRequest, webSearchMode: MarifoldWebSearchMode): {
    definitions: ToolDefinition[];
    execute: (name: string, args: Record<string, JSONValue>) => Promise<{ content: string; isError?: boolean }>;
  } | undefined {
    if (request.chatTools === false) return undefined;
    const webSearch = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
    if (!webSearch.enabled && webSearchMode !== 'fallback') return undefined;

    const agentConfig = this.resolveAgentConfigForProfile(request.profile);
    const approval = agentConfig.approval;
    const tools: AgentTool[] = [];
    if (webSearchMode === 'fallback') tools.push(new WebSearchTool(this.searchBackend, webSearch.maxResults));
    if (approval.read === 'allow') tools.push(new ReadFileTool());
    if (tools.length === 0) return undefined;

    const outputLimit = agentConfig.toolOutputLimit;
    return {
      definitions: tools.map(tool => tool.definition),
      execute: async (name, args) => {
        const tool = tools.find(t => t.definition.name === name);
        if (!tool) return { content: `Unknown tool '${name}'.`, isError: true };
        try {
          const result = await tool.execute(args, { cwd: process.cwd(), outputLimit });
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return { content: `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    };
  }

  private toPriestConfig(settings: MarifoldResolvedSettings, nativeWebSearch = false): PriestConfig {
    const { config } = this.options.loadedConfig;
    const provider = config.providers[settings.provider];
    const neutralReasoning = this.supportsNeutralReasoning(settings.provider, settings.model);
    const providerOptions: Record<string, JSONValue> = {};
    if (LEGACY_THINK_PROVIDER_NAMES.has(settings.provider)) providerOptions['think'] = settings.think;
    // Compatibility bridge for Priest 3.0.x. Priest 3.1 reads providerTools
    // directly; Marifold's Responses wrapper consumes and removes this marker
    // when an older engine does not forward that additive request field.
    if (nativeWebSearch) providerOptions[NATIVE_WEB_SEARCH_COMPAT_OPTION] = true;
    return {
      provider: settings.provider,
      model: settings.model,
      timeoutSeconds: config.default.timeoutSeconds,
      maxOutputTokens: config.default.maxOutputTokens,
      maxSystemChars: config.default.maxSystemChars,
      maxContextTokens: settings.maxContextTokens ?? config.default.maxContextTokens,
      compactionKeepTurns: config.default.compactionKeepTurns,
      sessionContextTurns: settings.sessionContextTurns ?? config.default.sessionContextTurns,
      reasoning: provider?.type === 'ollama'
        ? {
            enabled: settings.think,
            ...(settings.think ? { effort: 'high', summary: 'auto' as const } : {}),
          }
        : neutralReasoning && settings.think
          ? { enabled: true, effort: 'high', summary: 'auto' }
          : undefined,
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    };
  }

  private supportsNeutralReasoning(providerName: string, model: string): boolean {
    const provider = this.options.loadedConfig.config.providers[providerName];
    return provider?.type === 'ollama'
      || provider?.type === 'anthropic'
      || providerName === 'chatgpt'
      || (providerName === 'github_copilot' && isGitHubCopilotResponsesModelId(model));
  }

  private supportsThink(providerName: string, model: string): boolean {
    return LEGACY_THINK_PROVIDER_NAMES.has(providerName)
      || this.supportsNeutralReasoning(providerName, model);
  }

  /** Whether the profile's resolved provider honors thinking mode — so a channel
   * can tell the user when `/think` would have no effect. */
  profileSupportsThink(profile: string): boolean {
    const settings = this.resolveSettings({ profile });
    return this.supportsThink(settings.provider, settings.model);
  }

  private memoryForRequest(profile: string, requestMemories = true, prompt = '', thinking = false): string[] {
    const { config } = this.options.loadedConfig;
    if (!this.memoryEnabled(profile, requestMemories)) return [];
    this.ensureProfileMemoryFiles(profile);
    return this.memoryStore.listPromptMemory(profile, {
      contextLimit: config.memory.contextLimit,
      prompt,
      thinking,
    });
  }

  private resolveWebSearchMode(
    settings: Pick<MarifoldResolvedSettings, 'profile' | 'provider' | 'model'>,
    modelToolsEnabled = true,
  ): MarifoldWebSearchMode {
    if (!modelToolsEnabled) return 'unavailable';
    const approval = this.resolveAgentConfigForProfile(settings.profile).approval;
    if (approval.network === 'deny') return 'unavailable';
    if (this.providerFactory.supportsNativeWebSearch(settings.provider)) return 'native';
    return resolveWebSearchConfig(this.options.loadedConfig.config.webSearch).enabled
      ? 'fallback'
      : 'unavailable';
  }

  private providerToolsFor(mode: MarifoldWebSearchMode): MarifoldProviderToolDefinition[] | undefined {
    return mode === 'native' ? [{ type: 'web_search' }] : undefined;
  }

  private runtimeContext(
    memory: string[],
    prompt: string,
    memoryOn: boolean,
    webSearchMode: MarifoldWebSearchMode,
  ): string[] {
    const context = ['Running inside Marifold.'];
    if (webSearchMode === 'native') {
      context.push('Provider-hosted web search is available for this run. Use it for web or current-information requests; Marifold fallback search is not exposed while native search is available.');
    } else if (webSearchMode === 'unavailable') {
      context.push(WEB_SEARCH_UNAVAILABLE_CONTEXT);
    }
    if (memoryOn) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
      if (shouldInjectMemoryInstructions(prompt)) context.push(buildMemoryInstructions());
    } else if (memory.length > 0) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
    }
    return context;
  }

  private editHistoryContext(
    request: MarifoldRunRequest,
    settings: MarifoldResolvedSettings,
  ): string[] {
    if (request.replaceUserTurnIndex === undefined) return [];
    if (!request.sessionId) {
      throw MarifoldError.configInvalid('replaceUserTurnIndex requires sessionId.');
    }
    const turns = this.sessionResolver.turnsBeforeUserTurn(request.sessionId, request.replaceUserTurnIndex)
      ?? this.missingEditedTurn(request.sessionId, request.replaceUserTurnIndex);
    const history = buildHistoryContext(
      turns.map(turn => ({ role: turn.role, content: turn.content })),
      settings.maxContextTokens ?? EDIT_HISTORY_BUDGET_DEFAULT_CHARS,
    );
    return history ? [history] : [];
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
    if (!result.replaced) this.missingEditedTurn(sessionId, userTurnIndex);
  }

  private missingEditedTurn(sessionId: string, userTurnIndex: number): never {
    throw MarifoldError.configInvalid(
      `Cannot edit user turn ${userTurnIndex} because it is missing from session '${sessionId}'.`,
    );
  }

  private applyTurnMemory(
    profile: string,
    prompt: string,
    controls: MemoryControlPayloads,
    sessionId?: string,
  ): void {
    this.memoryStore.applySavePayloads(profile, controls.savePayloads, { sessionId });
    this.memoryStore.applyForgetPayloads(profile, controls.forgetPayloads);
    for (const query of extractPromptForgetQueries(prompt)) {
      this.memoryStore.forget(profile, query);
    }
    this.memoryStore.save(profile, extractPromptMemoryInputs(prompt), { sessionId });
    this.memoryStore.trimShortTerm(profile, this.options.loadedConfig.config.memory.sizeLimit);
  }
}

function completedResponseMetrics(
  mode: ProfileMode,
  settings: MarifoldResolvedSettings,
  startedAt: string,
  startedAtMs: number,
  usage?: UsageInfo,
): ResponseMetrics {
  const finishedAtMs = Date.now();
  return {
    mode,
    provider: settings.provider,
    model: settings.model,
    think: settings.think,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    latencyMs: Math.max(0, finishedAtMs - startedAtMs),
    ...(usage && Object.values(usage).some(value => value !== undefined) ? { usage: { ...usage } } : {}),
  };
}

/** Sum two provider usage reports, preserving undefined when neither side has
 * a given field (so absent token data stays absent rather than showing 0). */
function sumUsage(a: UsageInfo | undefined, b: UsageInfo | undefined): UsageInfo | undefined {
  if (!a) return b;
  if (!b) return a;
  const add = (x?: number, y?: number): number | undefined =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    cachedInputTokens: add(a.cachedInputTokens, b.cachedInputTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    estimatedCostUSD: add(a.estimatedCostUSD, b.estimatedCostUSD),
  };
}
