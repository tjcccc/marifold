import type { ImageInput, JSONValue, PriestRequest, PriestResponse, ToolDefinition, ToolExchangeTurn, UsageInfo } from '@priest-ai/core';
import * as path from 'path';
import { buildHistoryContext } from '../agent/AgentHistory';
import type { MarifoldAgentConfig } from '../agent/ApprovalPolicy';
import type { AgentTool } from '../agent/ToolRegistry';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { ReadWebPageTool } from '../agent/tools/ReadWebPageTool';
import { WebSearchTool } from '../agent/tools/WebSearchTool';
import { type LoadedMarifoldConfig, type ProfileMode, resolveWebSearchConfig } from '../config/ConfigSchema';
import type { NativeWebSearchStrategy } from '../config/ProviderFactory';
import { MarifoldError } from '../errors/MarifoldError';
import { prepareImageInputs } from '../images/ImageOptimizer';
import {
  MemoryControlStripper,
  buildMemoryInstructions,
  shouldInjectMemoryInstructions,
  stripMemoryControls,
} from '../memory/MemoryControls';
import type { MemoryControlPayloads } from '../memory/MemoryControls';
import type { MemoryStore } from '../memory/MemoryStore';
import { applyTurnMemory } from '../memory/TurnMemory';
import type { SearchBackend } from '../search/SearchBackend';
import { WebPageReader } from '../search/WebPageReader';
import { WEB_ANSWER_STYLE, webResearchGuidance } from '../search/WebResearchGuidance';
import type { ResponseMetrics } from '../sessions/ResponseMetrics';
import type { SessionResolver } from '../sessions/SessionResolver';
import type { MarifoldAskResponse, MarifoldProviderToolDefinition, MarifoldResolvedSettings, MarifoldRunRequest, MarifoldWebSearchMode } from './MarifoldTypes';
import { isNativeWebSearchCapabilityError } from './NativeWebSearch';
import type { ProviderEngines } from './ProviderEngines';
import { environmentContext, type RuntimeEnvironment } from './RuntimeEnvironment';

const CHAT_TOOL_MAX_ITERATIONS = 3;
const EDIT_HISTORY_BUDGET_DEFAULT_CHARS = 16_000;
const WEB_SEARCH_UNAVAILABLE_CONTEXT = 'Web search is unavailable for this run. If the user asks you to browse or search the web, or their question requires current information, say clearly that you cannot access web search; do not imply that you searched.';

/** What chat turns use from the runtime. MarifoldRuntime supplies closures
 * over its own methods, so spies installed on it still apply. */
export interface ChatTurnHost {
  readonly loadedConfig: LoadedMarifoldConfig;
  readonly environment: RuntimeEnvironment | undefined;
  readonly engines: ProviderEngines;
  readonly sessionResolver: SessionResolver;
  readonly memoryStore: MemoryStore;
  /** Read per turn: a `web_search.*` config edit replaces the backend. */
  searchBackend(): SearchBackend;
  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think' | 'maxContextTokens'>): MarifoldResolvedSettings;
  assertSessionAvailable(sessionId: string, owner?: string): void;
  assertSessionWritable(sessionId: string): void;
  memoryEnabled(profile: string, requestMemories?: boolean): boolean;
  memoryForRequest(profile: string, requestMemories?: boolean, prompt?: string, thinking?: boolean): string[];
  resolveAgentConfigForProfile(profile?: string): MarifoldAgentConfig;
  resolveWebSearch(
    settings: Pick<MarifoldResolvedSettings, 'profile' | 'provider' | 'model'>,
    modelToolsEnabled?: boolean,
  ): { mode: MarifoldWebSearchMode; nativeStrategy: NativeWebSearchStrategy };
  fallbackWebSearchAvailable(settings: Pick<MarifoldResolvedSettings, 'profile'>, modelToolsEnabled?: boolean): boolean;
  providerToolsFor(mode: MarifoldWebSearchMode, nativeStrategy: NativeWebSearchStrategy): MarifoldProviderToolDefinition[] | undefined;
  replaceEditedExchange(
    sessionId: string,
    userTurnIndex: number,
    userText: string,
    assistantText: string,
    images?: ImageInput[],
    responseMetrics?: ResponseMetrics,
  ): void;
  missingEditedTurn(sessionId: string, userTurnIndex: number): never;
}

/**
 * One chat turn through the Priest engine (`ask` and streaming `stream`):
 * profile memory, the bounded caller-executed web search/read tool loop with
 * hosted-search fallback, session persistence, and memory control payloads.
 * Ordinary messages use Agent runs; this path serves chat-mode Skills and
 * compatibility clients.
 */
export class ChatTurns {
  constructor(private readonly host: ChatTurnHost) {}

  async ask(request: MarifoldRunRequest): Promise<MarifoldAskResponse> {
    if (request.sessionId) { this.host.assertSessionAvailable(request.sessionId, request.sessionOwner); this.host.assertSessionWritable(request.sessionId); }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const settings = this.host.resolveSettings(request);
    const environment = environmentContext({ ...this.host.environment, ...request.environment }, new Date(startedAtMs), settings);
    const preparedImages = await prepareImageInputs(request.images, { optimize: request.originalImages !== true });
    const historyImages = preparedImages.images.map((image, index) => request.images?.[index]?.path
      ? { path: path.resolve(request.images[index].path!), mediaType: preparedImages.summaries[index]?.sourceMediaType ?? request.images[index].mediaType }
      : image);
    await this.host.engines.refreshCredentials(settings.provider);
    const replacing = request.replaceUserTurnIndex !== undefined;
    const isolated = request.isolated === true;
    const engine = this.host.engines.create(
      settings.provider,
      Boolean(request.sessionId) && !replacing && !isolated,
      request.profileContext !== false,
    );
    const memoryOn = this.host.memoryEnabled(settings.profile, request.memories);
    const memory = this.host.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const searchResolution = this.host.resolveWebSearch(settings, request.chatTools !== false);
    let webSearchMode = searchResolution.mode;
    let chatTools = this.chatTools(request, webSearchMode);
    const nativeFallbackAvailable = webSearchMode === 'native'
      && this.host.fallbackWebSearchAvailable(settings, request.chatTools !== false);
    let nativeFallbackAttempted = false;
    const buildPriestRequest = (): PriestRequest & { providerTools?: MarifoldProviderToolDefinition[] } => ({
      config: this.host.engines.priestConfig(
        settings,
        webSearchMode === 'native' ? searchResolution.nativeStrategy : 'none',
      ),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId && !replacing && !isolated
        ? { id: request.sessionId, createIfMissing: true }
        : undefined,
      context: [
        environment,
        ...this.runtimeContext(memory, request.prompt, memoryOn, webSearchMode),
        ...this.editHistoryContext(request, settings),
        ...(request.instructions ?? []),
      ],
      memory,
      images: preparedImages.images.length > 0 ? preparedImages.images : undefined,
      userContext: request.userContext,
      providerTools: this.host.providerToolsFor(webSearchMode, searchResolution.nativeStrategy),
    });
    let priestRequest = buildPriestRequest();
    const exchange: ToolExchangeTurn[] = [];
    const maxIterations = chatTools || nativeFallbackAvailable ? CHAT_TOOL_MAX_ITERATIONS : 1;
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
      if (
        !response.ok
        && webSearchMode === 'native'
        && nativeFallbackAvailable
        && !nativeFallbackAttempted
        && isNativeWebSearchCapabilityError(response.error)
      ) {
        nativeFallbackAttempted = true;
        webSearchMode = 'fallback';
        chatTools = this.chatTools(request, webSearchMode);
        priestRequest = buildPriestRequest();
        iteration -= 1;
        continue;
      }
      if (!response.ok || !chatTools || !response.toolCalls?.length) { break; }

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
      this.host.assertSessionAvailable(request.sessionId, request.sessionOwner);
      if (request.replaceUserTurnIndex !== undefined) {
        this.host.replaceEditedExchange(
          request.sessionId,
          request.replaceUserTurnIndex,
          userTurn,
          stripped.text,
          historyImages,
          responseMetrics,
        );
      } else if (isolated) {
        await this.host.sessionResolver.appendExchange(
          request.sessionId,
          settings.profile,
          userTurn,
          stripped.text,
          historyImages,
          responseMetrics,
        );
      } else {
        if (request.userTurn) { this.host.sessionResolver.replaceLastUserTurn(request.sessionId, request.userTurn); }
        this.host.sessionResolver.replaceLastAssistantTurn(request.sessionId, stripped.text);
        this.host.sessionResolver.saveLastUserTurnAttachments(request.sessionId, historyImages);
        this.host.sessionResolver.saveLastResponseMetrics(request.sessionId, responseMetrics);
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
    if (request.sessionId) { this.host.assertSessionAvailable(request.sessionId, request.sessionOwner); this.host.assertSessionWritable(request.sessionId); }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const settings = this.host.resolveSettings(request);
    const environment = environmentContext({ ...this.host.environment, ...request.environment }, new Date(startedAtMs), settings);
    const preparedImages = await prepareImageInputs(request.images, { optimize: request.originalImages !== true });
    const historyImages = preparedImages.images.map((image, index) => request.images?.[index]?.path
      ? { path: path.resolve(request.images[index].path!), mediaType: preparedImages.summaries[index]?.sourceMediaType ?? request.images[index].mediaType }
      : image);
    await this.host.engines.refreshCredentials(settings.provider);
    let aggregateUsage: UsageInfo | undefined;
    const replacing = request.replaceUserTurnIndex !== undefined;
    const isolated = request.isolated === true;
    const enginePersistsSession = Boolean(request.sessionId) && !replacing && !isolated;
    const sessionWasMissing = enginePersistsSession
      ? this.host.sessionResolver.get(request.sessionId!) === undefined
      : false;
    const engine = this.host.engines.create(
      settings.provider,
      enginePersistsSession,
      request.profileContext !== false,
    );
    const memoryOn = this.host.memoryEnabled(settings.profile, request.memories);
    const memory = this.host.memoryForRequest(settings.profile, request.memories, request.prompt, settings.think);
    const searchResolution = this.host.resolveWebSearch(settings, request.chatTools !== false);
    let webSearchMode = searchResolution.mode;
    let chatTools = this.chatTools(request, webSearchMode);
    const nativeFallbackAvailable = webSearchMode === 'native'
      && this.host.fallbackWebSearchAvailable(settings, request.chatTools !== false);
    let nativeFallbackAttempted = false;
    const buildBaseRequest = (): PriestRequest & { providerTools?: MarifoldProviderToolDefinition[] } => ({
      config: this.host.engines.priestConfig(
        settings,
        webSearchMode === 'native' ? searchResolution.nativeStrategy : 'none',
      ),
      profile: settings.profile,
      prompt: request.prompt,
      session: request.sessionId && !replacing && !isolated
        ? { id: request.sessionId, createIfMissing: true }
        : undefined,
      context: [
        environment,
        ...this.runtimeContext(memory, request.prompt, memoryOn, webSearchMode),
        ...this.editHistoryContext(request, settings),
        ...(request.instructions ?? []),
      ],
      memory,
      images: preparedImages.images.length > 0 ? preparedImages.images : undefined,
      userContext: request.userContext,
      providerTools: this.host.providerToolsFor(webSearchMode, searchResolution.nativeStrategy),
    });
    let baseRequest = buildBaseRequest();

    // Caller-executed fallback/read loop. Provider-hosted search is carried
    // separately and does not enter Marifold's tool exchange.
    // Intermediate tool-call turns are turn-local; the engine persists the
    // session only on the loop's final response, and memory payloads are
    // applied only from that final response.
    const exchange: ToolExchangeTurn[] = [];
    const maxIterations = chatTools || nativeFallbackAvailable ? CHAT_TOOL_MAX_ITERATIONS : 1;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const stripper = new MemoryControlStripper();
      const visibleParts: string[] = [];
      let done: PriestResponse | undefined;
      let providerOutputStarted = false;
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
          providerOutputStarted = true;
          const visible = stripper.feed(event.text);
          if (visible) {
            visibleParts.push(visible);
            yield visible;
          }
        } else if (event.type === 'reasoning_summary_delta') {
          providerOutputStarted = true;
          onReasoningSummary?.(event.text);
        } else if (
          event.type === 'tool_call_start'
          || event.type === 'tool_call_delta'
          || event.type === 'tool_call_end'
        ) {
          providerOutputStarted = true;
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
      if (
        !providerOutputStarted
        && webSearchMode === 'native'
        && nativeFallbackAvailable
        && !nativeFallbackAttempted
        && isNativeWebSearchCapabilityError(done?.error)
      ) {
        nativeFallbackAttempted = true;
        webSearchMode = 'fallback';
        chatTools = this.chatTools(request, webSearchMode);
        baseRequest = buildBaseRequest();
        iteration -= 1;
        continue;
      }
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
        if (streamedText.length === 0 && finalText) { yield finalText; }
        const userTurn = request.userTurn ?? request.prompt;
        const responseMetrics = completedResponseMetrics(
          'chat',
          settings,
          startedAt,
          startedAtMs,
          aggregateUsage,
        );
        if (request.sessionId) {
          this.host.assertSessionAvailable(request.sessionId, request.sessionOwner);
          if (request.replaceUserTurnIndex !== undefined) {
            this.host.replaceEditedExchange(
              request.sessionId,
              request.replaceUserTurnIndex,
              userTurn,
              finalText,
              historyImages,
              responseMetrics,
            );
          } else if (isolated) {
            await this.host.sessionResolver.appendExchange(
              request.sessionId,
              settings.profile,
              userTurn,
              finalText,
              historyImages,
              responseMetrics,
            );
          } else {
            if (request.userTurn) { this.host.sessionResolver.replaceLastUserTurn(request.sessionId, request.userTurn); }
            this.host.sessionResolver.replaceLastAssistantTurn(request.sessionId, finalText);
            this.host.sessionResolver.saveLastUserTurnAttachments(request.sessionId, historyImages);
            this.host.sessionResolver.saveLastResponseMetrics(request.sessionId, responseMetrics);
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

  private discardFailedNewSession(sessionId: string | undefined, sessionWasMissing: boolean): void {
    if (!sessionId || !sessionWasMissing) { return; }
    const session = this.host.sessionResolver.get(sessionId);
    if (session?.turnCount === 0) { this.host.sessionResolver.delete(sessionId); }
  }

  /** Caller-executed tools for chat turns. Marifold web_search is advertised
   * only in fallback mode; provider-hosted search travels separately. */
  private chatTools(request: MarifoldRunRequest, webSearchMode: MarifoldWebSearchMode): {
    definitions: ToolDefinition[];
    execute: (name: string, args: Record<string, JSONValue>) => Promise<{ content: string; isError?: boolean }>;
  } | undefined {
    if (request.chatTools === false) { return undefined; }
    const webSearch = resolveWebSearchConfig(this.host.loadedConfig.config.webSearch);
    if (!webSearch.enabled && webSearchMode !== 'fallback') { return undefined; }

    const agentConfig = this.host.resolveAgentConfigForProfile(request.profile);
    const approval = agentConfig.approval;
    const tools: AgentTool[] = [];
    if (webSearchMode === 'fallback') { tools.push(new WebSearchTool(this.host.searchBackend(), webSearch.maxResults), new ReadWebPageTool(new WebPageReader({ proxy: webSearch.proxy }))); }
    if (approval.read === 'allow') { tools.push(new ReadFileTool()); }
    if (tools.length === 0) { return undefined; }

    const outputLimit = agentConfig.toolOutputLimit;
    const toolContext = { cwd: process.cwd(), outputLimit, signal: request.signal };
    return {
      definitions: tools.map(tool => tool.definition),
      execute: async (name, args) => {
        const tool = tools.find(t => t.definition.name === name);
        if (!tool) { return { content: `Unknown tool '${name}'.`, isError: true }; }
        try {
          const result = await tool.execute(args, toolContext);
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return { content: `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    };
  }

  private runtimeContext(
    memory: string[],
    prompt: string,
    memoryOn: boolean,
    webSearchMode: MarifoldWebSearchMode,
  ): string[] {
    const context = ['Running inside Marifold.'];
    if (webSearchMode === 'native') {
      context.push('Provider-hosted web search is available for this run. Use it for web or current-information requests; Marifold fallback search is not exposed while native search is available. ' + WEB_ANSWER_STYLE);
    } else if (webSearchMode === 'fallback') {
      context.push(webResearchGuidance());
    } else if (webSearchMode === 'unavailable') {
      context.push(WEB_SEARCH_UNAVAILABLE_CONTEXT);
    }
    if (memoryOn) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
      if (shouldInjectMemoryInstructions(prompt)) { context.push(buildMemoryInstructions()); }
    } else if (memory.length > 0) {
      context.push('Profile memory is app-owned context. Current user messages and profile rules outrank memory.');
    }
    return context;
  }

  private editHistoryContext(
    request: MarifoldRunRequest,
    settings: MarifoldResolvedSettings,
  ): string[] {
    if (request.replaceUserTurnIndex === undefined) { return []; }
    if (!request.sessionId) {
      throw MarifoldError.configInvalid('replaceUserTurnIndex requires sessionId.');
    }
    const turns = this.host.sessionResolver.turnsBeforeUserTurn(request.sessionId, request.replaceUserTurnIndex)
      ?? this.host.missingEditedTurn(request.sessionId, request.replaceUserTurnIndex);
    const history = buildHistoryContext(
      turns.map(turn => ({ role: turn.role, content: turn.content })),
      settings.maxContextTokens ?? EDIT_HISTORY_BUDGET_DEFAULT_CHARS,
    );
    return history ? [history] : [];
  }

  private applyTurnMemory(
    profile: string,
    prompt: string,
    controls: MemoryControlPayloads,
    sessionId?: string,
  ): void {
    applyTurnMemory(this.host.memoryStore, profile, prompt, controls, { sessionId, sizeLimit: this.host.loadedConfig.config.memory.sizeLimit });
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
  if (!a) { return b; }
  if (!b) { return a; }
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
