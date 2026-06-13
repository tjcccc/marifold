import { JSONValue, PriestConfig, PriestEngine, PriestRequest, PriestResponse, ToolDefinition, ToolExchangeTurn } from '@priest-ai/core';
import * as path from 'path';
import { AgentRunner } from '../agent/AgentRunner';
import { resolveAgentConfig } from '../agent/ApprovalPolicy';
import { DelegateTool } from '../agent/tools/DelegateTool';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { ShellExecTool } from '../agent/tools/ShellExecTool';
import { WebSearchTool } from '../agent/tools/WebSearchTool';
import { WriteFileTool } from '../agent/tools/WriteFileTool';
import { AgentTool, ToolRegistry } from '../agent/ToolRegistry';
import { ChatGptRefreshedTokens, refreshChatGptAccessToken } from '../config/ChatGptTokenRefresh';
import { ConfigManager } from '../config/ConfigManager';
import { LoadedMarifoldConfig, ProfileDetail, ProfileSummary, resolveWebSearchConfig, SessionDetail, SessionSummary } from '../config/ConfigSchema';
import { exchangeGitHubTokenForCopilotToken } from '../config/GitHubCopilotAuth';
import { DuckDuckGoBackend } from '../search/DuckDuckGoBackend';
import { formatSearchResults, SearchBackend } from '../search/SearchBackend';
import { ProviderFactory } from '../config/ProviderFactory';
import { MarifoldError } from '../errors/MarifoldError';
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
import { Scheduler } from '../schedule/Scheduler';
import { ScheduleCreateInput, ScheduleState, ScheduleStore, ScheduleUpdateInput } from '../schedule/ScheduleStore';
import { SessionResolver } from '../sessions/SessionResolver';
import { SkillStore } from '../skill/SkillStore';
import { MarifoldSkill } from '../skill/SkillSchema';
import { SkillScope } from '../skill/SkillStore';
import { TaskStore } from '../tasks/TaskStore';
import { defaultSchedulesDir, defaultSkillsDir } from '../workspace/WorkspacePaths';
import type { TaskCreateInput, TaskEventInput, TaskListOptions, TaskState, TaskSummary, TaskUpdateInput } from '../tasks/TaskStore';
import { MarifoldAskResponse, MarifoldResolvedSettings, MarifoldRunRequest } from './MarifoldTypes';

const THINK_PROVIDER_NAMES = new Set(['bailian', 'alibaba_cloud']);
const CHAT_TOOL_MAX_ITERATIONS = 3;

export interface MarifoldRuntimeOptions {
  loadedConfig: LoadedMarifoldConfig;
  /** Override the web search backend (tests, alternative engines). */
  searchBackend?: SearchBackend;
}

export class MarifoldRuntime {
  private readonly profileResolver: ProfileResolver;
  private readonly sessionResolver: SessionResolver;
  private readonly providerFactory: ProviderFactory;
  private readonly memoryStore: MemoryStore;
  private readonly taskStore: TaskStore;
  private readonly searchBackend: SearchBackend;
  private readonly scheduleStore: ScheduleStore;

  constructor(private readonly options: MarifoldRuntimeOptions) {
    const { config, configPath } = options.loadedConfig;
    this.profileResolver = new ProfileResolver(config.paths.profilesDir);
    this.sessionResolver = new SessionResolver(config.paths.sessionsDb);
    this.providerFactory = new ProviderFactory(config, configPath);
    this.memoryStore = new MemoryStore(config.paths.profilesDir);
    this.taskStore = new TaskStore(config.paths.tasksDir);
    this.searchBackend = options.searchBackend
      ?? new DuckDuckGoBackend({ proxy: resolveWebSearchConfig(config.webSearch).proxy });
    this.scheduleStore = new ScheduleStore(config.paths.schedulesDir ?? defaultSchedulesDir());
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
    const memory = this.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const response = await engine.run({
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: this.runtimeContext(memory, request.prompt, memoryOn),
      memory,
      images: request.images,
      userContext: request.userContext,
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
    const memory = this.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const chatTools = this.chatTools(request);

    const baseRequest: PriestRequest = {
      config: this.toPriestConfig(settings),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId ? { id: request.sessionId, createIfMissing: true } : undefined,
      context: this.runtimeContext(memory, request.prompt, memoryOn),
      memory,
      images: request.images,
      userContext: request.userContext,
    };

    // Model-initiated tool loop (web_search/read_file) when [web_search].enabled.
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

      for await (const event of engine.streamEvents({
        ...baseRequest,
        ...(chatTools && !lastIteration ? { tools: chatTools.definitions } : {}),
        ...(exchange.length > 0 ? { toolExchange: exchange } : {}),
      })) {
        if (event.type === 'text_delta') {
          const visible = stripper.feed(event.text);
          if (visible) {
            visibleParts.push(visible);
            yield visible;
          }
        } else if (event.type === 'done') {
          done = event.response;
        }
      }
      const tail = stripper.flush();
      if (tail) {
        visibleParts.push(tail);
        yield tail;
      }

      const toolCalls = done?.toolCalls ?? [];
      if (!chatTools || toolCalls.length === 0) {
        if (request.sessionId) {
          this.sessionResolver.replaceLastAssistantTurn(request.sessionId, visibleParts.join(''));
        }
        if (memoryOn) {
          this.applyTurnMemory(settings.profile, request.prompt, stripper, request.sessionId);
        }
        return;
      }

      exchange.push({ kind: 'assistant', text: done?.text, toolCalls });
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

  /**
   * Build an approval-aware agent runner over this runtime's engine wiring,
   * TaskStore, and config policy. Pass a custom registry to replace the
   * default file/shell/delegate tool set.
   */
  createAgentRunner(registry?: ToolRegistry): AgentRunner {
    return new AgentRunner({
      taskStore: this.taskStore,
      registry: registry ?? this.createDefaultToolRegistry(),
      agentConfig: resolveAgentConfig(this.options.loadedConfig.config.agent),
      resolveSettings: request => this.resolveSettings(request),
      prepareEngine: async settings => {
        await this.refreshProviderCredentialsIfNeeded(settings.provider);
        return {
          engine: this.createEngine(settings.provider, false),
          config: this.toPriestConfig(settings),
        };
      },
    });
  }

  private createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new ShellExecTool());
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

  listSkills(profile?: string): MarifoldSkill[] {
    return this.createSkillStore(profile).list();
  }

  getSkill(name: string, profile?: string): MarifoldSkill | undefined {
    return this.createSkillStore(profile).get(name);
  }

  installSkillFromText(text: string, scope: SkillScope = 'global', profile?: string): MarifoldSkill {
    return this.createSkillStore(profile).installFromText(text, scope);
  }

  installSkillFromFile(filePath: string, scope: SkillScope = 'global', profile?: string): MarifoldSkill {
    return this.createSkillStore(profile).installFromFile(filePath, scope);
  }

  removeSkill(name: string, profile?: string): boolean {
    return this.createSkillStore(profile).remove(name);
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

  private async runScheduledAgent(schedule: ScheduleState): Promise<{ taskId?: string; status: string }> {
    const runner = this.createAgentRunner();
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

  private createEngine(providerName: string, useSession: boolean): PriestEngine {
    const adapter = this.providerFactory.create(providerName);
    return new PriestEngine(
      this.profileResolver,
      useSession ? this.sessionResolver.openStore() : undefined,
      { [providerName]: adapter },
    );
  }

  private async refreshProviderCredentialsIfNeeded(providerName: string): Promise<void> {
    if (providerName !== 'github_copilot' && providerName !== 'chatgpt') return;

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
          `GitHub Copilot authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Re-run marifold model add github_copilot to authorize again.`,
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
      new ConfigManager(this.options.loadedConfig).save();
    } catch (error) {
      throw MarifoldError.configInvalid(
        `ChatGPT authorization could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Re-run marifold model add chatgpt to sign in again.`,
      );
    }
  }

  /**
   * Model-initiated tools for chat turns. Opt-in via [web_search].enabled;
   * web_search joins unless network policy is deny, read_file joins only when
   * read policy is allow.
   */
  private chatTools(request: MarifoldRunRequest): {
    definitions: ToolDefinition[];
    execute: (name: string, args: Record<string, JSONValue>) => Promise<{ content: string; isError?: boolean }>;
  } | undefined {
    const webSearch = resolveWebSearchConfig(this.options.loadedConfig.config.webSearch);
    if (!webSearch.enabled || request.chatTools === false) return undefined;

    const approval = resolveAgentConfig(this.options.loadedConfig.config.agent).approval;
    const tools: AgentTool[] = [];
    if (approval.network !== 'deny') tools.push(new WebSearchTool(this.searchBackend, webSearch.maxResults));
    if (approval.read === 'allow') tools.push(new ReadFileTool());
    if (tools.length === 0) return undefined;

    const outputLimit = resolveAgentConfig(this.options.loadedConfig.config.agent).toolOutputLimit;
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
    for (const query of extractPromptForgetQueries(prompt)) {
      this.memoryStore.forget(profile, query);
    }
    this.memoryStore.save(profile, extractPromptMemoryInputs(prompt), { sessionId });
    this.memoryStore.trimShortTerm(profile, this.options.loadedConfig.config.memory.sizeLimit);
  }
}
