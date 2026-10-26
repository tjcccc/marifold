import { WorkspaceDevicesTool } from './WorkspaceDevicesTool';
import { DeviceDelegateTool, type DeviceChildRun } from './DeviceDelegateTool';
import type { JSONValue } from '@priest-ai/core';
import { record, randomId } from '@marifold/workspace-protocol';
import type { AgentRunner } from '../agent/AgentRunner';
import type { RunArtifact } from '../agent/RunArtifacts';
import { portableTrustedFolders, type RunWorkspace } from '../agent/RunWorkspace';
import {
  UncertainToolOutcomeError,
  ToolRegistry,
  type ToolExecutionResult,
  type ToolRiskAssessment,
} from '../agent/ToolRegistry';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import { mentionsSkillManagement } from '../skill/BuiltInSkillManager';
import { mentionsAgentComputer } from '../computer/ComputerTools';
import { mentionsMarifoldState } from './RemoteStateAccess';
import type { RunStartInput } from '../runs/RunRegistry';
import { SkillManagementTool } from '../agent/tools/SkillManagementTool';
import { executionTools } from './WorkspaceExecutor';
import type { WorkspaceManager, WorkspaceOperationContext } from './WorkspaceManager';

export class WorkspaceRuns {
  private delegate?: (parentRunId: string, input: RunStartInput) => DeviceChildRun;
  setDelegate(start: (parentRunId: string, input: RunStartInput) => DeviceChildRun): void {
    this.delegate = start;
  }
  constructor(
    private readonly runtime: MarifoldRuntime,
    private readonly manager: WorkspaceManager,
  ) {}
  devices(origin?: WorkspaceOperationContext) {
    const id = origin?.workspaceId ?? this.manager.store.list().find(c => c.role === 'host')?.id;
    return id ? this.manager.devices(id) : [];
  }
  async resolve(
    input: RunStartInput,
    selection: { workspaceId?: string; executionDeviceId?: string },
    origin?: WorkspaceOperationContext,
  ): Promise<RunStartInput> {
    const mentions = [...input.objective.matchAll(/(^|\s)@(?:"([^"\r\n]+)"|([^\s"]+))(?=\s|$)/g)];
    if (mentions.length > 1) { throw new Error('Select one @device per task.'); }
    const mention = mentions[0];
    const task = mention ? (input.objective.slice(0, mention.index) + input.objective.slice(mention.index! + mention[0].length)).trim() : input.objective;
    if ((input.objective.startsWith('@') && !mention) || (mention && !task)) {
      throw new Error('Use @device with a task.');
    }
    if (mention && /^[$/]/.test(task)) {
      throw new Error('Use a plain task with @device; run skills and commands separately.');
    }
    // Hosting shares this same local workspace; local runs need its device tools too.
    const workspaceId = origin?.workspaceId ?? selection.workspaceId ??
      this.manager.store.list().find(connection => connection.role === 'host')?.id;
    if (!workspaceId) {
      if (selection.executionDeviceId || mention) { throw new Error('Select a workspace before an execution device.'); }
      return input;
    }
    const connection = this.manager.store.get(workspaceId);
    if (connection.role !== 'host') { throw new Error('Run must be submitted to the workspace host.'); }
    const originId = origin?.senderDeviceId ?? connection.deviceId;
    const devices = this.manager.devices(connection.id);
    const skill = input.lean || /^\s*\$[\w-]+/.test(input.userTurn ?? input.objective);
    // Skills are installed on the host, so Automatic sends management there too;
    // likewise work on the agent computer, which the host drives, and requests
    // about ~/.marifold, where the host keeps the profiles and skills.
    const management = mentionsSkillManagement(input.userTurn ?? input.objective);
    const computer = mentionsAgentComputer(input.userTurn ?? input.objective);
    const hostOwned = skill || management || computer || mentionsMarifoldState(input.userTurn ?? input.objective);
    const mentioned = mention?.[2] ?? mention?.[3];
    const find = (value: string) => devices.filter(d => d.id === value || d.name.toLowerCase() === value.toLowerCase());
    // Accept a possessive ("@office's folder") when no device carries that exact name.
    const possessive = mentioned?.replace(/['’]s$/i, '');
    const name = mentioned && possessive !== mentioned && find(mentioned).length === 0 ? possessive : mentioned;
    const matches = name ? find(name) : [];
    if (name && matches.length !== 1) { throw new Error('The mentioned device is unknown or ambiguous. Select a device from the @ menu.'); }
    // "install abc from @office's ~/x" or "copy @office's ~/x to your computer":
    // the mention names where the source is and the run stays on the host, which
    // has the skill tools and drives the agent computer. Any other @device
    // still routes the run there.
    const sourceMention = mention !== undefined && (computer || (management && isSkillSourceMention(
      input.objective.slice(0, mention.index! + mention[1].length),
      input.objective,
    )));
    const explicit = name && !sourceMention ? matches[0]!.id : selection.executionDeviceId;
    const executionDeviceId =
      explicit === 'host'
        ? connection.hostDeviceId
        : (explicit ??
          (hostOwned
            ? connection.hostDeviceId
            : (devices.find((d) => d.id === originId && d.executor)?.id ?? connection.hostDeviceId)));
    if (skill && executionDeviceId !== connection.hostDeviceId) {
      throw new Error('Skills execute on the workspace host in this version.');
    }
    const device = devices.find((d) => d.id === executionDeviceId);
    if (!device || !device.online || !device.executor) {
      throw new Error('The selected execution device is unavailable or has disabled execution.');
    }
    return { ...input, environment: { ...input.environment, request: input.environment?.request === 'remote' || originId !== connection.hostDeviceId ? 'remote' : 'local' }, execution: { workspaceId: connection.id, originDeviceId: originId, executionDeviceId } };
  }
  createRunner(input: RunStartInput): AgentRunner {
    const execution = input.execution;
    if (!execution) { return this.runtime.createAgentRunner(input.profile); }
    const { workspaceId, executionDeviceId } = execution;
    const host = this.manager.store.get(workspaceId);
    const devices = this.manager.devices(workspaceId);
    const management = mentionsSkillManagement(input.userTurn ?? input.objective);
    const guestSkillManagement = executionDeviceId !== host.hostDeviceId && management;
    const guestComputer = executionDeviceId !== host.hostDeviceId && mentionsAgentComputer(input.userTurn ?? input.objective);
    const deviceName = (id: string) => devices.find(d => d.id === id)?.name ?? id;
    const requesting = deviceName(execution.originDeviceId);
    const contextInstructions = [
      `Tools and paths belong to ${executionDeviceId === host.hostDeviceId ? 'the workspace host' : 'the selected execution device'}. For a named-device or host task, use list_devices to resolve the target and delegate_device if needed. For an existing file, use its published reference; do not recapture or recreate it merely to deliver it.`,
      ...(execution.originDeviceId !== executionDeviceId
        ? [`This request came from the device "${requesting}"; "my current device" or "this computer" means it.`]
        : []),
      ...(guestSkillManagement
        ? ['Marifold skills are installed, updated, removed, and configured on the workspace host with its manage_skill tool, which this device run does not have. Use delegate_device with host for that work instead of searching Marifold directories on this device; if the source is on this device, name this device in the objective as the source device.']
        : []),
      ...(guestComputer
        ? ['"Your computer" means the agent computer: an isolated Linux computer the workspace host drives, not the host and not this device. This run has no computer_* tools. Use delegate_device with host and an objective that says "on the agent computer" and names the computer_* tool to use; never write the result to the host\'s own files.']
        : []),
      ...(management && executionDeviceId === host.hostDeviceId
        ? [`Skill sources: when the user names no device, the source path is on the workspace host "${deviceName(host.hostDeviceId)}"; omit source_device. When the user names a device (an @device mention, a device name, or "my current device"), pass it as manage_skill source_device. Say which device the source was read from.`]
        : []),
      'Device delegation uses the workspace bridge connection, not SSH or Tailscale, and does not require shell network access or device login credentials. Check list_devices before claiming a device is unavailable. Guest execution requires its executor opt-in; file tools follow the same approval policy as on the host, and shell_exec defaults to scoped access. Check shell_job_status on the execution device: when full access is locally enabled, shell_exec access=full has that device account’s normal filesystem, network, process and application permissions. For administrator commands that need a password, use sudo_exec: its secure approval prompts on the requesting device, not the execution device. Never collect passwords in chat, ask_user, shell arguments or files. macOS privacy permissions still depend on the device. Full-access jobs continue after disconnect/cancellation; retrieve their status rather than repeating uncertain commands. For permission questions, explain these capabilities and limits without starting work.',
    ];
    const registry =
      executionDeviceId === host.hostDeviceId
        ? this.runtime.createDefaultToolRegistry(input.profile)
        : this.runtime.createHostContextTools(input.profile);
    const skills = registry.get('manage_skill');
    if (skills instanceof SkillManagementTool) {
      skills.useSourceDevices({
        hostName: deviceName(host.hostDeviceId),
        resolve: (reference) => {
          const wanted = reference.toLowerCase();
          const matches = this.manager.devices(workspaceId).filter(d =>
            d.id === reference || d.name.toLowerCase() === wanted || (wanted === 'host' && d.host));
          if (matches.length !== 1) { throw new Error(`Device "${reference}" is unknown or ambiguous; use a name or ID from list_devices.`); }
          return { id: matches[0]!.id, name: matches[0]!.name, host: matches[0]!.id === host.hostDeviceId };
        },
        fetch: async (deviceId, source) => {
          const device = this.manager.devices(workspaceId).find(d => d.id === deviceId);
          if (!device?.online || !device.executor) {
            throw new Error(`Device "${device?.name ?? deviceId}" is offline or has not enabled execution.`);
          }
          return this.manager.execute(workspaceId, deviceId, 'executor.skillBundle', { path: source });
        },
      });
    }
    registry.register(new WorkspaceDevicesTool(() => ({
      workspace: { id: workspaceId, name: host.name, hostDeviceId: host.hostDeviceId },
      executionDeviceId,
      devices: this.manager.devices(workspaceId),
    })));
    if (!input.parentRunId && !input.lean && input.registryRunId && this.delegate) {
      registry.register(
        new DeviceDelegateTool(async (selected, objective) => {
          const matches = this.manager
            .devices(workspaceId)
            .filter((d) => d.id === selected || d.name === selected || ((selected === 'host' || selected === host.name) && d.host));
          if (matches.length !== 1) { throw new Error('Device name is ambiguous or unknown; use its ID.'); }
          const child = await this.resolve(
            {
              objective,
              environment: input.environment,
              profile: input.profile,
              provider: input.provider,
              model: input.model,
              deep: input.deep,
              files: input.files,
              images: input.images,
            },
            { executionDeviceId: matches[0].id },
            { workspaceId, senderDeviceId: execution.originDeviceId, hostDeviceId: host.hostDeviceId },
          );
          return this.delegate!(input.registryRunId!, child);
        }, () => Boolean(registry.get('computer_exec'))),
      );
    }
    if (executionDeviceId === host.hostDeviceId) {
      // A request from another device may read the host's Marifold state with
      // approval, never its credentials or workspace keys, and never write it.
      const stateAccess = execution.originDeviceId !== host.hostDeviceId ? this.runtime.remoteStateAccess() : undefined;
      return this.runtime.createAgentRunner(input.profile, registry, undefined, { contextInstructions, ...(stateAccess ? { stateAccess } : {}) });
    }
    let runId: string;
    let lease: ReturnType<typeof setInterval> | undefined;
    let signal: AbortSignal | undefined;
    const request = (operation: string, body: unknown, id?: string) =>
      this.manager.execute(workspaceId, executionDeviceId, operation, body, id);
    const stop = () => {
      clearInterval(lease);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      stop();
      void request('executor.cancel', { runId }).catch(() => undefined);
    };
    for (const tool of executionTools()) {
      let grant: string | undefined;
      registry.register({
        definition: tool.definition,
        kind: tool.kind,
        summarizeCall: (value) =>
          `[${devices.find((device) => device.id === executionDeviceId)?.name ?? executionDeviceId}] ${tool.summarizeCall(value)}`,
        assessRisk: async (value, context) => {
          signal = context.signal;
          if (signal?.aborted) { throw new Error('Run cancelled.'); }
          signal?.removeEventListener('abort', cancel);
          signal?.addEventListener('abort', cancel, { once: true });
          const assessment = (await request('executor.assess', {
            runId,
            tool: tool.definition.name,
            input: value,
          })) as ToolRiskAssessment & { grant: string };
          grant = assessment.grant;
          return assessment;
        },
        execute: async (value, context): Promise<ToolExecutionResult> => {
          if (context.signal?.aborted) { throw new Error('Run cancelled.'); }
          const permission = grant;
          grant = undefined;
          try {
            return (await request(
              'executor.execute',
              { runId, tool: tool.definition.name, input: value, grant: permission, ...(context.sudoResponse ? { sudoResponse: context.sudoResponse } : {}) },
              randomId(),
            )) as ToolExecutionResult;
          } catch (error) {
            cancel();
            throw new UncertainToolOutcomeError(
              `Execution stopped. The remote call may have completed; inspect the target device before retrying. ${error instanceof Error ? error.message : ''}`,
            );
          }
        },
      });
    }
    return this.runtime.createAgentRunner(input.profile, registry, undefined, {
      contextInstructions,
      deviceInstructions: 'Tools run on the selected execution device. All tool paths, home directory, and operating system belong to it. Do not substitute host paths. Skills and Apps run on the workspace host in a separate run.',
      createWorkspace: async (options) => {
        runId = options.id;
        const workspace = (await request('executor.prepare', {
          runId,
          cwd: input.cwd,
          // Home-relative entries only; the device validates them against its own home.
          trustedFolders: portableTrustedFolders(options.trustedFolders ?? []),
          files: options.files,
          images: options.images,
        })) as RunWorkspace;
        lease = setInterval(() => {
          void request('executor.lease', { runId }).catch(() => undefined);
        }, 10000);
        lease.unref();
        return workspace;
      },
      listArtifacts: async () => {
        stop();
        return (await request('executor.artifacts', { runId })) as RunArtifact[];
      },
    });
  }
}

/** True when an @device mention follows "from"/从 in an install or update request. */
function isSkillSourceMention(beforeMention: string, objective: string): boolean {
  return /(?:\bfrom|从)\s*$/i.test(beforeMention)
    && /\b(?:install|reinstall|update|upgrade)\b|安装|更新|升级/i.test(objective);
}
