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
    return { ...input, execution: { workspaceId: connection.id, originDeviceId: originId, executionDeviceId } };
  }
  createRunner(input: RunStartInput): AgentRunner {
    const execution = input.execution;
    if (!execution) return this.runtime.createAgentRunner(input.profile);
    const { workspaceId, executionDeviceId } = execution;
    const host = this.manager.store.get(workspaceId);
    const devices = this.manager.devices(workspaceId);
    const contextInstructions = [
      `Device context (metadata): ${JSON.stringify({ workspaceId, workspaceName: host.name, hostDeviceId: host.hostDeviceId, originDeviceId: execution.originDeviceId, executionDeviceId, devices })}. All file paths and tools belong to the execution device. Skills and Apps run on the host. Device delegation is limited to this workspace.`,
      'The requesting device (originDeviceId) is the user’s current device; it may differ from the execution device and workspace host. A request naming this workspace (for example home) refers to its host, not automatically to the current execution device. Before device-specific work such as taking a desktop screenshot, resolve the named device from this metadata and use delegate_device if it differs from executionDeviceId. If the target is ambiguous or cannot be reached, ask instead of acting on another device.',
      'Generated files in the run output directory are offered through Download controls in the conversation. Clicking Download transfers bytes to the browser’s device, regardless of which device created the file. Writing to Desktop or Downloads through a tool only writes on the execution device. For a request to send an already generated file, direct the user to its existing Download control; do not take a new screenshot, recreate the file, or delegate another capture just to deliver it. Never claim a browser download completed without evidence.',
    ];
    const registry =
      executionDeviceId === host.hostDeviceId
        ? this.runtime.createDefaultToolRegistry(input.profile)
        : this.runtime.createHostContextTools(input.profile);
    if (!input.parentRunId && !input.lean && input.registryRunId && this.delegate) {
      registry.register(
        new DeviceDelegateTool(async (selected, objective) => {
          const matches = this.manager
            .devices(workspaceId)
            .filter((d) => d.id === selected || d.name === selected || (selected === 'host' && d.host));
          if (matches.length !== 1) throw new Error('Device name is ambiguous or unknown; use its ID.');
          const child = await this.resolve(
            {
              objective,
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
      deviceInstructions: `This run uses a model on the workspace host and tools on execution device ${executionDeviceId}. The requesting device is ${execution.originDeviceId}. All tool paths, home directory, and operating system belong to the execution device. Do not substitute host paths. Skills and Apps must be run on the host in a separate run.`,
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
