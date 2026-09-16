import { WorkspaceDevicesTool } from './WorkspaceDevicesTool';
import { DeviceDelegateTool, type DeviceChildRun } from './DeviceDelegateTool';
import type { JSONValue } from '@priest-ai/core';
import { record, randomId } from '@marifold/workspace-protocol';
import type { AgentRunner } from '../agent/AgentRunner';
import type { RunArtifact } from '../agent/RunArtifacts';
import type { RunWorkspace } from '../agent/RunWorkspace';
import {
  UncertainToolOutcomeError,
  ToolRegistry,
  type ToolExecutionResult,
  type ToolRiskAssessment,
} from '../agent/ToolRegistry';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import type { RunStartInput } from '../runs/RunRegistry';
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
  async resolve(
    input: RunStartInput,
    selection: { workspaceId?: string; executionDeviceId?: string },
    origin?: WorkspaceOperationContext,
  ): Promise<RunStartInput> {
    const workspaceId = origin?.workspaceId ?? selection.workspaceId;
    if (!workspaceId) {
      if (selection.executionDeviceId) throw new Error('Select a workspace before an execution device.');
      return input;
    }
    const connection = this.manager.store.get(workspaceId);
    if (connection.role !== 'host') throw new Error('Run must be submitted to the workspace host.');
    const originId = origin?.senderDeviceId ?? connection.deviceId;
    const devices = this.manager.devices(connection.id);
    const skill = input.lean || /^\s*\$[\w-]+/.test(input.userTurn ?? input.objective);
    const explicit = selection.executionDeviceId;
    const executionDeviceId =
      explicit === 'host'
        ? connection.hostDeviceId
        : (explicit ??
          (skill
            ? connection.hostDeviceId
            : (devices.find((d) => d.id === originId && d.executor)?.id ?? connection.hostDeviceId)));
    if (skill && executionDeviceId !== connection.hostDeviceId)
      throw new Error('Skills execute on the workspace host in this version.');
    const device = devices.find((d) => d.id === executionDeviceId);
    if (!device || !device.online || !device.executor)
      throw new Error('The selected execution device is unavailable or has disabled execution.');
    return { ...input, environment: { ...input.environment, request: input.environment?.request === 'remote' || originId !== connection.hostDeviceId ? 'remote' : 'local' }, execution: { workspaceId: connection.id, originDeviceId: originId, executionDeviceId } };
  }
  createRunner(input: RunStartInput): AgentRunner {
    const execution = input.execution;
    if (!execution) return this.runtime.createAgentRunner(input.profile);
    const { workspaceId, executionDeviceId } = execution;
    const host = this.manager.store.get(workspaceId);
    const devices = this.manager.devices(workspaceId);
    const contextInstructions = [
      `Tools and paths belong to ${executionDeviceId === host.hostDeviceId ? 'the workspace host' : 'the selected execution device'}. For a named-device or host task, use list_devices to resolve the target and delegate_device if needed. For an existing file, use its published reference; do not recapture or recreate it merely to deliver it.`,
    ];
    const registry =
      executionDeviceId === host.hostDeviceId
        ? this.runtime.createDefaultToolRegistry(input.profile)
        : this.runtime.createHostContextTools(input.profile);
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
          if (matches.length !== 1) throw new Error('Device name is ambiguous or unknown; use its ID.');
          const child = await this.resolve(
            {
              objective,
              environment: input.environment,
              profile: input.profile,
              provider: input.provider,
              model: input.model,
              think: input.think,
              files: input.files,
              images: input.images,
            },
            { executionDeviceId: matches[0].id },
            { workspaceId, senderDeviceId: execution.originDeviceId, hostDeviceId: host.hostDeviceId },
          );
          return this.delegate!(input.registryRunId!, child);
        }),
      );
    }
    if (executionDeviceId === host.hostDeviceId)
      return this.runtime.createAgentRunner(input.profile, registry, undefined, { contextInstructions });
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
          if (signal?.aborted) throw new Error('Run cancelled.');
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
          if (context.signal?.aborted) throw new Error('Run cancelled.');
          const permission = grant;
          grant = undefined;
          try {
            return (await request(
              'executor.execute',
              { runId, tool: tool.definition.name, input: value, grant: permission },
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
