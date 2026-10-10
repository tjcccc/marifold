import * as path from 'path';
import type { ImageInput, PriestResponse, UsageInfo } from '@priest-ai/core';
import { buildHistoryContext } from '../agent/AgentHistory';
import type { AgentRunner } from '../agent/AgentRunner';
import type { MarifoldAgentConfig } from '../agent/ApprovalPolicy';
import type { RunFileInput } from '../agent/RunWorkspace';
import { ToolRegistry } from '../agent/ToolRegistry';
import { AskUserTool } from '../agent/tools/AskUserTool';
import { InspectAttachmentTool } from '../agent/tools/InspectAttachmentTool';
import { ReadAttachmentTool } from '../agent/tools/ReadAttachmentTool';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { SearchAttachmentTool } from '../agent/tools/SearchAttachmentTool';
import { SkillAppContextTool, SkillAppManagementTool } from '../agent/tools/SkillAppTools';
import type { AppStore } from '../app/AppStore';
import { resolveHostReadGrant } from '../app/HostReadGrants';
import type { SkillAppInteractionHandlers } from '../app/SkillAppInstanceRegistry';
import { resolveSkillAppOperation as resolveSkillAppOperationDefinition } from '../app/SkillAppResolver';
import type {
  SkillAppAttachmentInput,
  SkillAppDefinition,
  SkillAppHistoryTurn,
  SkillAppInstalledEffect,
  SkillAppResult,
  SkillAppStateValue,
} from '../app/SkillAppSchema';
import type { LoadedMarifoldConfig, ProfileSummary } from '../config/ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';
import { stripMemoryControls } from '../memory/MemoryControls';
import type { MarifoldSkill } from '../skill/SkillSchema';
import { defaultAppsDir, marifoldHome } from '../workspace/WorkspacePaths';
import type { MarifoldResolvedSettings, MarifoldRunRequest } from './MarifoldTypes';
import type { ProviderEngines } from './ProviderEngines';

/** What SkillApp operations use from the runtime. MarifoldRuntime supplies
 * closures over its own methods, so spies installed on it still apply. */
export interface SkillAppOperationHost {
  readonly loadedConfig: LoadedMarifoldConfig;
  readonly engines: ProviderEngines;
  createAppStore(directory?: string): AppStore;
  resolveSettings(request: Pick<MarifoldRunRequest, 'profile' | 'provider' | 'model' | 'think' | 'maxContextTokens'>): MarifoldResolvedSettings;
  memoryForRequest(profile: string, requestMemories?: boolean, prompt?: string, thinking?: boolean): string[];
  resolveAgentConfigForProfile(profile?: string): MarifoldAgentConfig;
  createAgentRunner(
    profile: string,
    registry: ToolRegistry,
    agentConfig: MarifoldAgentConfig,
    runtimeOptions: { webSearch: boolean; readOnlyFolders: string[]; readOnlyFiles: string[]; allowExternalReadOnlyFolders: boolean },
  ): AgentRunner;
  listApps(): SkillAppDefinition[];
  listProfiles(): ProfileSummary[];
  listSkills(profile?: string): MarifoldSkill[];
}

/** Executes statically compiled SkillApp operations: v1 profile-free model
 * calls, and v2 profile Skills through an isolated, read-only Agent run. */
export class SkillAppOperations {
  constructor(private readonly host: SkillAppOperationHost) {}

  async run(
    appName: string,
    operationName: string,
    state: Record<string, SkillAppStateValue>,
    signal?: AbortSignal,
    history?: SkillAppHistoryTurn[],
    attachments?: SkillAppAttachmentInput[],
    interactions?: SkillAppInteractionHandlers,
  ): Promise<SkillAppResult> {
    const startedAt = Date.now();
    try {
      const store = this.host.createAppStore();
      const definition = store.require(appName);
      const operation = resolveSkillAppOperationDefinition(
        store,
        definition,
        operationName,
        state,
      );
      const declaredOperation = definition.operations.find(candidate => candidate.name === operationName)!;
      let settings: MarifoldResolvedSettings;
      let text: string;
      let usage: UsageInfo | undefined;
      let effects: SkillAppInstalledEffect[] | undefined;
      if (operation.profile) {
        settings = this.host.resolveSettings({
          profile: operation.profile.profile,
          ...(operation.profile.provider ? { provider: operation.profile.provider } : {}),
          ...(operation.profile.model ? { model: operation.profile.model } : {}),
          ...(operation.profile.think !== undefined ? { think: operation.profile.think } : {}),
        });
        const memory = this.host.memoryForRequest(
          settings.profile,
          operation.profile.memory,
          operation.prompt,
          settings.think,
        );
        const historyContext = operation.profile.history && history?.length
          ? buildHistoryContext(history, 16_000)
          : undefined;
        const instructions = [
          ...operation.instructions,
          ...(historyContext ? [historyContext] : []),
        ];
        // Profile-backed App operations default to the product's single Agent
        // path. An explicitly chat-mode Skill still uses the retained transport.
        const mode = operation.mode ?? 'agent';
        if (declaredOperation.interactive && mode !== 'agent') {
          throw MarifoldError.appInvalid(
            `Interactive SkillApp operation '${operationName}' must invoke an Agent Skill.`,
          );
        }
        if (mode === 'agent') {
          const skillReads = resolveSkillReads(operation.name, operation.skillReads, operation.skillDirectory);
          if (skillReads.length > 0) {
            instructions.push(
              `The selected Skill declares these read-only files; read them with read_file when needed: ${skillReads.join(', ')}`,
            );
          }
          const run = await this.runProfileAgent(
            appName,
            operation.operationName,
            settings,
            operation.prompt,
            instructions,
            memory,
            operation.skillDirectory,
            [
              ...(definition.permissions ?? []),
              ...skillReads.map(file => ({ kind: 'file' as const, path: file, access: 'read' as const })),
            ],
            attachments,
            signal,
            interactions,
            operation.name,
          );
          text = run.text;
          usage = run.usage;
          effects = run.effects;
        } else {
          if (attachments?.some(attachment => attachment.kind === 'file')) {
            throw MarifoldError.appInvalid(
              `SkillApp operation '${operationName}' needs Agent mode to inspect non-image attachments.`,
            );
          }
          await this.host.engines.refreshCredentials(settings.provider);
          const response = await this.host.engines.create(settings.provider, false).run({
            config: this.host.engines.priestConfig(settings),
            profile: settings.profile,
            prompt: operation.prompt,
            context: instructions,
            ...(memory.length > 0 ? { memory } : {}),
            ...(attachments?.some(attachment => attachment.kind === 'image') ? {
              images: attachments
                .filter(attachment => attachment.kind === 'image')
                .map(attachment => ({ data: attachment.data, mediaType: attachment.mediaType })),
            } : {}),
          }, signal ? { signal } : undefined);
          text = requireSkillAppResponseText(response, settings);
          usage = response.usage;
        }
      } else {
        if (!operation.model) {
          throw MarifoldError.appInvalid(`SkillApp operation '${operationName}' has no model.`);
        }
        settings = {
          profile: `skillapp-${appName}`,
          provider: operation.model.provider,
          model: operation.model.model,
          think: operation.model.think,
          mode: 'chat',
        };
        await this.host.engines.refreshCredentials(settings.provider);
        const response = await this.host.engines.create(settings.provider, false, false).run({
          config: this.host.engines.priestConfig(settings),
          profile: settings.profile,
          prompt: operation.prompt,
          context: operation.instructions,
        }, signal ? { signal } : undefined);
        text = requireSkillAppResponseText(response, settings);
        usage = response.usage;
      }
      text = stripMemoryControls(text).text;
      text = operation.result.trim ? text.trim() : text;
      return {
        status: 'ok',
        data: { text },
        meta: {
          engine: settings.provider,
          model: settings.model,
          durationMs: Date.now() - startedAt,
          ...(usage ? { usage } : {}),
        },
        ...(effects && effects.length > 0 ? { effects } : {}),
      };
    } catch (error) {
      if (signal?.aborted) { throw error; }
      return {
        status: 'error',
        error: {
          code: error instanceof MarifoldError ? error.code : 'APP_INVALID',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async runProfileAgent(
    appName: string,
    operationName: string,
    settings: MarifoldResolvedSettings,
    prompt: string,
    instructions: string[],
    memory: string[],
    skillDirectory?: string,
    permissions: NonNullable<SkillAppDefinition['permissions']> = [],
    attachments: SkillAppAttachmentInput[] = [],
    signal?: AbortSignal,
    interactions?: SkillAppInteractionHandlers,
    skillName?: string,
  ): Promise<{ text: string; usage?: UsageInfo; effects?: SkillAppInstalledEffect[] }> {
    const registry = new ToolRegistry();
    if (interactions) { registry.register(new AskUserTool()); }
    if (attachments.length > 0) {
      registry.register(new InspectAttachmentTool());
      registry.register(new ReadAttachmentTool());
      registry.register(new SearchAttachmentTool());
    }
    if (skillDirectory || permissions.length > 0) {
      registry.register(new ReadFileTool({ strictWorkspace: true }));
    }
    const effects: SkillAppInstalledEffect[] = [];
    if (skillName === 'skillapp-builder') {
      const { config } = this.host.loadedConfig;
      const appsDir = config.paths.appsDir ?? defaultAppsDir();
      registry.register(new SkillAppContextTool({
        activeProfile: settings.profile,
        appsDir,
        listApps: () => this.host.listApps().map(definition => definition.app),
        listProfiles: () => this.host.listProfiles(),
        listSkills: profileName => this.host.listSkills(profileName),
      }));
      registry.register(new SkillAppManagementTool({
        appsDir,
        createStore: directory => this.host.createAppStore(directory),
        onInstalled: effect => {
          effects.push(effect);
          interactions?.effectHandler?.(effect);
        },
      }));
    }
    const base = this.host.resolveAgentConfigForProfile(settings.profile);
    const isolatedConfig: MarifoldAgentConfig = {
      ...base,
      approval: {
        read: 'allow',
        write: interactions && skillName === 'skillapp-builder' ? 'ask' : 'deny',
        shell: 'deny',
        network: 'deny',
        delegate: 'deny',
      },
      trustedFolders: [],
    };
    const runner = this.host.createAgentRunner(
      settings.profile,
      registry,
      isolatedConfig,
      {
        webSearch: false,
        readOnlyFolders: [
          ...(skillDirectory ? [skillDirectory] : []),
          ...permissions.filter(permission => permission.kind === 'folder').map(permission => permission.path),
        ],
        readOnlyFiles: permissions
          .filter(permission => permission.kind === 'file')
          .map(permission => permission.path),
        allowExternalReadOnlyFolders: true,
      },
    );
    const images: ImageInput[] = attachments
      .filter(attachment => attachment.kind === 'image')
      .map(attachment => ({ data: attachment.data, mediaType: attachment.mediaType }));
    const files: RunFileInput[] = attachments
      .filter(attachment => attachment.kind === 'file')
      .map(attachment => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        data: attachment.data,
        ...(attachment.inspectionText !== undefined ? { inspectionText: attachment.inspectionText } : {}),
      }));
    let finalText: string | undefined;
    let failure: { code: string; message: string } | undefined;
    let status: string | undefined;
    let terminalSummary: string | undefined;
    let lastBuilderValidationError: string | undefined;
    let usage: UsageInfo | undefined;
    for await (const event of runner.run({
      objective: prompt,
      profile: settings.profile,
      provider: settings.provider,
      model: settings.model,
      think: settings.think,
      lean: true,
      instructions,
      ...(images.length > 0 || files.length > 0 ? {
        images,
        files,
      } : {}),
      ...(memory.length > 0 ? { memory } : {}),
      cwd: marifoldHome(),
      tags: ['skillapp', appName, operationName],
      ...(skillName === 'skillapp-builder' ? {
        maxIterations: Math.min(isolatedConfig.maxIterations, 8),
      } : {}),
      signal,
      ...(interactions ? {
        approvalHandler: interactions.approvalHandler,
        userInputHandler: interactions.userInputHandler,
      } : {}),
    })) {
      if (event.type === 'text' && event.phase === 'final') { finalText = event.text; }
      if (event.type === 'error') { failure = { code: event.code, message: event.message }; }
      if (event.type === 'tool_result' && event.tool === 'manage_skill_app' && event.isError) {
        lastBuilderValidationError = event.summary;
      }
      if (event.type === 'done') {
        status = event.status;
        terminalSummary = event.summary;
        usage = event.usage;
      }
    }
    if (status !== 'completed' || finalText === undefined) {
      const terminalFailure = failure?.message
        ?? terminalSummary
        ?? `Profile Skill operation '${operationName}' did not produce a final response.`;
      throw MarifoldError.providerError(
        lastBuilderValidationError
          ? `${terminalFailure} Last builder error: ${lastBuilderValidationError}`
          : terminalFailure,
        settings.provider,
        settings.model,
        failure?.code ?? 'APP_SKILL_FAILED',
      );
    }
    return {
      text: finalText,
      ...(usage ? { usage } : {}),
      ...(effects.length > 0 ? { effects } : {}),
    };
  }
}

/** Resolve the selected Skill's declared reads through the same boundary as
 * static App permissions. Exact files only; a bad declaration fails the run. */
function resolveSkillReads(skillName: string, declared: string[] | undefined, skillDirectory?: string): string[] {
  return [...new Set((declared ?? []).map(file => resolveHostReadGrant({
    declared: file,
    kind: 'file',
    label: `Skill '${skillName}' declared`,
    noun: 'read',
    // A skill may declare its own bundled files, even under Marifold's skills folders.
    ...(skillDirectory ? { allowedPrivateRoot: skillDirectory } : {}),
    ...(skillDirectory ? { source: path.join(skillDirectory, 'SKILL.md') } : {}),
  })))];
}

function requireSkillAppResponseText(
  response: PriestResponse,
  settings: Pick<MarifoldResolvedSettings, 'provider' | 'model'>,
): string {
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
  return response.text;
}
