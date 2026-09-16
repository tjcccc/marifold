import * as fs from 'node:fs';
import { createApiClient, followRunEvents, type ApiClientOptions, type ApiClient } from '@marifold/client';
import { prepareImageInputs } from '@marifold/core';
import type {
  AgentEvent,
  AgentRunOptions,
  LoadedMarifoldConfig,
  MarifoldRuntime,
  MarifoldResolvedSettings,
  RunRecord,
  ProfileSummary,
  MarifoldSkill,
  MarifoldAgentConfig,
} from '@marifold/core';
import type { TuiRuntime } from './TuiRuntime.js';
interface Snapshot {
  summary: ProfileSummary;
  detail: ReturnType<MarifoldRuntime['getProfile']>;
  settings?: MarifoldResolvedSettings;
  agent: MarifoldAgentConfig;
  skills: Record<'all' | 'global' | 'profile', MarifoldSkill[]>;
}
export class RemoteRuntime implements TuiRuntime {
  readonly api: ApiClient;
  private snapshot: Snapshot[] = [];
  loadedConfig!: LoadedMarifoldConfig;
  constructor(options: ApiClientOptions) {
    this.api = createApiClient({ ...options, interface: 'terminal' });
  }
  async refresh(): Promise<void> {
    const [snapshot, config] = await Promise.all([
      this.call<Snapshot[]>('snapshot', {}),
      this.api.request<{ config: LoadedMarifoldConfig['config'] }>('GET', '/v1/config'),
    ]);
    this.snapshot = snapshot;
    this.loadedConfig = {
      config: config.config,
      foundConfig: true,
      configPath: '(workspace host)',
    } as LoadedMarifoldConfig;
  }
  private async call<T>(operation: string, input: unknown): Promise<T> {
    return (await this.api.request<{ result: T }>('POST', `/v1/terminal/${operation}`, input)).result;
  }
  private async mutate<T>(operation: string, input: unknown): Promise<T> {
    const result = await this.call<T>(operation, input);
    await this.refresh();
    return result;
  }
  private entry(profile?: string) {
    const p = this.snapshot.find((e) => e.summary.name === (profile ?? this.loadedConfig.config.default.profile));
    if (!p) throw new Error('Profile not found.');
    return p;
  }
  listProfiles: TuiRuntime['listProfiles'] = () => this.snapshot.map((e) => e.summary);
  getProfile: TuiRuntime['getProfile'] = (name) => this.entry(name).detail;
  resolveSettings: TuiRuntime['resolveSettings'] = (request) => {
    const s = this.entry(request.profile).settings;
    if (!s) throw new Error('Profile has no configured model.');
    return {
      ...s,
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.model ? { model: request.model } : {}),
    };
  };
  resolveAgentConfigForProfile: TuiRuntime['resolveAgentConfigForProfile'] = (name) => this.entry(name).agent;
  listSkills: TuiRuntime['listSkills'] = (profile, scope) => this.entry(profile).skills[scope ?? 'all'];
  getSkill: TuiRuntime['getSkill'] = (name, profile) => this.listSkills(profile).find((s) => s.name === name);
  listSessions: TuiRuntime['listSessions'] = async (limit = 20, profile) =>
    (
      await this.api.request<{ sessions: Awaited<ReturnType<MarifoldRuntime['listSessions']>> }>(
        'GET',
        `/v1/sessions?limit=${limit}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`,
      )
    ).sessions;
  getSession: TuiRuntime['getSession'] = async (id) =>
    (
      await this.api.request<{ session: ReturnType<MarifoldRuntime['getSession']> }>(
        'GET',
        `/v1/sessions/${encodeURIComponent(id)}`,
      )
    ).session;
  setProfileAgentApproval: TuiRuntime['setProfileAgentApproval'] = (profile, kind, mode) =>
    this.mutate('profile.approval', { profile, kind, mode });
  addProfileTrustedFolder: TuiRuntime['addProfileTrustedFolder'] = (profile, folder) =>
    this.mutate('profile.trust', { profile, folder });
  migrateProfileInstructions: TuiRuntime['migrateProfileInstructions'] = (profile) =>
    this.mutate('profile.migrate', { profile });
  installSkillFromText: TuiRuntime['installSkillFromText'] = (
    text,
    scope = 'global',
    profile = this.loadedConfig.config.default.profile,
  ) => this.mutate('skill.install', { text, scope, profile });
  installSkillFromFile: TuiRuntime['installSkillFromFile'] = (file, scope, profile) =>
    this.installSkillFromText(fs.readFileSync(file, 'utf8'), scope, profile);
  removeSkill: TuiRuntime['removeSkill'] = (
    name,
    profile = this.loadedConfig.config.default.profile,
    scope = 'global',
  ) => this.mutate('skill.remove', { name, profile, scope });
  rememberMemory: TuiRuntime['rememberMemory'] = (profile, _kind, text, sessionId) =>
    this.mutate('memory.remember', { profile, text, sessionId });
  forgetMemories: TuiRuntime['forgetMemories'] = (profile, query) => this.mutate('memory.forget', { profile, query });
  deleteMemories: TuiRuntime['deleteMemories'] = (profile, query) => this.mutate('memory.delete', { profile, query });
  setProfileMaxContextTokens: TuiRuntime['setProfileMaxContextTokens'] = (profile, tokens) =>
    this.mutate('profile.context', { profile, tokens: tokens ?? null });
  compactSession: TuiRuntime['compactSession'] = async (id, input) =>
    await this.api.request<Awaited<ReturnType<MarifoldRuntime['compactSession']>>>(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/compact`,
      input,
    );
  createAgentRunner() {
    return { run: (options: AgentRunOptions) => this.run(options) };
  }
  private async *run(options: AgentRunOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const { signal, approvalHandler, userInputHandler, steering, ...input } = options;
    if (signal?.aborted) return;
    if (input.images?.length) input.images = (await prepareImageInputs(input.images)).images;
    const { run } = await this.api.request<{ run: RunRecord }>('POST', '/v1/runs', input);
    const post = (suffix: string, body: unknown) => this.api.request('POST', `/v1/runs/${run.id}/${suffix}`, body);
    const cancel = () => {
      void post('cancel', {}).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const failures: string[] = [];
    const report = (error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error));
    };
    const timer = setInterval(() => {
      for (const text of steering?.() ?? []) void post('steer', { text }).catch(report);
    }, 500);
    try {
      for await (const event of followRunEvents<AgentEvent>(this.api, run.id, signal)) {
        for (const message of failures.splice(0))
          yield { type: 'error', code: 'WORKSPACE_INTERACTION_FAILED', message };
        yield event;
        if (event.type === 'approval_request')
          void Promise.resolve(approvalHandler?.(event.request))
            .then((decision) => post(`approvals/${event.request.id}`, { action: decision?.approved ? 'once' : 'deny' }))
            .catch(report);
        if (event.type === 'user_input_request')
          void Promise.resolve(userInputHandler?.(event.request))
            .then((submission) => post(`inputs/${event.request.id}`, submission ?? { skipped: true }))
            .catch(report);
      }
    } finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  stream: TuiRuntime['stream'] = async function* (
    this: RemoteRuntime,
    request: Parameters<MarifoldRuntime['stream']>[0],
    onSummary?: Parameters<MarifoldRuntime['stream']>[1],
    onReasoning?: Parameters<MarifoldRuntime['stream']>[2],
  ) {
    for await (const event of this.run({
      objective: request.prompt,
      profile: request.profile,
      provider: request.provider,
      model: request.model,
      sessionId: request.sessionId,
      images: request.images,
      think: request.think,
      lean: true,
      instructions: request.instructions,
      userTurn: request.userTurn,
      signal: request.signal,
    })) {
      if (event.type === 'text') yield event.text;
      if (event.type === 'reasoning') onReasoning?.(event.summary);
    }
  }.bind(this);
}
