import type { JSONValue } from '@priest-ai/core';
import type { DeviceExecution } from '../DeviceExecution';
import { capToolOutput, type AgentTool, type ToolExecutionContext, type ToolExecutionResult } from '../ToolRegistry';

export class ShellJobStatusTool implements AgentTool {
  constructor(private readonly device?: DeviceExecution) {}
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'shell_job_status',
    description: 'Read this device’s execution mode and full-access shell job status. When to use: check full-access availability, wait for a job, or retrieve its result after reconnecting instead of repeating a command with an uncertain outcome. When NOT to use: start, cancel or retry a command. Omit job_id to list the 20 most recent jobs (without output). Running jobs continue after chat cancellation. Job output may contain private device data.',
    parameters: { type: 'object', properties: {
      job_id: { type: 'string', description: 'Durable shell job ID on this device.' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 10, description: 'Optionally wait up to 10 seconds for the job to finish.' },
    } },
  };
  summarizeCall(input: Record<string, JSONValue>): string {
    return input.job_id ? `read shell job ${input.job_id}` : 'read device execution mode and recent shell jobs';
  }
  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (input.job_id !== undefined && typeof input.job_id !== 'string') { throw new Error('Invalid shell job ID.'); }
    const wait = input.wait_seconds ?? 0;
    if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > 10) { throw new Error('Invalid wait_seconds.'); }
    if (!this.device) { return { content: JSON.stringify({ mode: 'scoped', jobs: [] }) }; }
    const until = Date.now() + wait * 1000;
    let job = input.job_id ? this.device.status(input.job_id, ctx.jobScope) : undefined;
    while (job && ['queued', 'running'].includes(job.state) && Date.now() < until && !ctx.signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = this.device.status(job.id, ctx.jobScope);
    }
    if (job?.output) { job = { ...job, output: capToolOutput(job.output, ctx.outputLimit) }; }
    return { content: JSON.stringify({ mode: this.device.mode(), ...(job ? { job } : { jobs: this.device.recent(ctx.jobScope) }) }),
      summary: job ? `shell job ${job.id}: ${job.state}` : `device execution: ${this.device.mode()}` };
  }
}
