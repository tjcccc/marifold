import { createHash } from 'node:crypto';
import type { AgentEvent } from '../agent/AgentEvents';
import {
  UncertainToolOutcomeError,
  requireStringInput,
  type AgentTool,
  type ToolExecutionContext,
} from '../agent/ToolRegistry';
import type { JSONValue } from '@priest-ai/core';
import type { SequencedEvent } from '../runs/RunRegistry';

export interface DeviceChildRun {
  runId: string;
  events: AsyncGenerator<SequencedEvent, void, unknown>;
  cancel(): void;
}
export class DeviceDelegateTool implements AgentTool {
  readonly kind = 'delegate' as const;
  readonly definition = {
    name: 'delegate_device',
    description:
      'Ask another online device in this personal workspace to carry out one bounded objective with this profile and model. The child cannot delegate again. Approval is required. Use host for the workspace host, or a device name or ID returned by list_devices. Filesystem paths belong to the selected device; do not translate them from the requesting device.',
    parameters: {
      type: 'object',
      properties: { device: { type: 'string' }, objective: { type: 'string' } },
      required: ['device', 'objective'],
    },
  };
  constructor(private readonly start: (device: string, objective: string) => Promise<DeviceChildRun>) {}
  summarizeCall(input: Record<string, JSONValue>): string {
    return `ask device ${String(input.device)} to ${String(input.objective).slice(0, 160)}`;
  }
  assessRisk() {
    return { escalate: true, persistable: false, reason: 'This starts agent work on another device.' };
  }
  async execute(input: Record<string, JSONValue>, context: ToolExecutionContext) {
    if (context.signal?.aborted) throw new Error('Run cancelled.');
    const child = await this.start(
      requireStringInput(input, 'device', this.definition.name),
      requireStringInput(input, 'objective', this.definition.name),
    );
    const cancel = () => child.cancel();
    context.signal?.addEventListener('abort', cancel, { once: true });
    if (context.signal?.aborted) cancel();
    let status = 'failed';
    let summary = '';
    let error = '';
    try {
      for await (const { event } of child.events) {
        if (event.type === 'done') {
          status = event.status;
          summary = event.summary ?? summary;
          continue;
        }
        if (event.type === 'status' || event.type === 'plan' || event.type === 'step') continue;
        if (event.type === 'error') error = event.message;
        let forwarded: AgentEvent = event;
        if (event.type === 'text') {
          summary = event.text;
          forwarded = { ...event, phase: 'progress' };
        }
        if (event.type === 'artifact')
          forwarded = {
            type: 'artifact',
            artifact: {
              ...event.artifact,
              id: createHash('sha256').update(`${child.runId}:${event.artifact.id}`).digest('hex').slice(0, 24),
              source: { runId: child.runId, artifactId: event.artifact.id },
            },
          };
        context.emitEvent?.(forwarded);
      }
      if (status !== 'completed')
        throw new UncertainToolOutcomeError(
          `Device run ${child.runId} ended ${status}. Inspect its results before retrying any effects. ${error}`,
        );
      return {
        content: `Device run ${child.runId} completed.\n${summary}`,
        summary: `device run ${child.runId} completed`,
      };
    } finally {
      context.signal?.removeEventListener('abort', cancel);
      child.cancel();
    }
  }
}
