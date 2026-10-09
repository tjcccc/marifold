import { JSONValue } from '@priest-ai/core';
import { ensurePythonEnvironment, runScopedProcess } from '../ScopedProcess';
import { DeviceExecution } from '../DeviceExecution';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

export class ShellExecTool implements AgentTool {
  constructor(private readonly device?: DeviceExecution) {}
  readonly kind = 'shell' as const;
  readonly definition = {
    name: 'shell_exec',
    description: [
      'Run a shell command. Default access=scoped uses the isolated workspace and a 60-second timeout.',
      'Explicit access=full requires device-local opt-in and approval for every call. It runs with the Marifold account filesystem, network, process, environment and application permissions, not automatic administrator rights.',
      'Full-access commands return a durable job ID immediately; use shell_job_status to retrieve completion. They continue after chat cancellation or bridge disconnection, with a 10-minute limit. Never blindly repeat a command after a lost response; inspect recent jobs first.',
      'When to use: run a focused test, build, formatter, program, or filesystem/process operation that dedicated tools cannot perform.',
      'When NOT to use: scoped text reads/writes or isolated Python package installs that dedicated tools support, or unnecessary demonstration commands. Scoped commands cannot access the network. Use full access only when the requested device operation needs account-level capabilities.',
      'Scoped access can write only the working directory, configured trusted folders, and private run directories—even after approval. Check shell_job_status for the device mode before requesting full access.',
      'For an explicit output file elsewhere, use write_file instead of shell redirection.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run. ~ and $HOME refer to the user home. Scoped access retains filesystem sandbox limits.' },
        access: { type: 'string', enum: ['scoped', 'full'], description: 'Default scoped. Full access requires this device to have enabled it locally.' },
      },
      required: ['command'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `${input.access === 'full' ? '[FULL DEVICE ACCESS; continues after disconnect] ' : ''}run \`${typeof input.command === 'string' ? input.command : '<missing command>'}\``;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (input.access !== undefined && input.access !== 'scoped' && input.access !== 'full') {
      return { blocked: true, escalate: false, reason: 'Invalid shell access mode.' };
    }
    if (input.access === 'full') {
      return { blocked: this.device?.mode() !== 'full', escalate: true, persistable: false,
        reason: this.device?.mode() === 'full'
          ? 'Full device access as the Marifold OS user. This job continues after cancellation or disconnect; approval applies to this command only.'
          : 'Full access is disabled on this device. The owner must enable it locally with marifold execution mode full.' };
    }
    if (!ctx.workspace) {
      return {
        blocked: true,
        escalate: false,
        persistable: false,
        reason: 'shell execution has no isolated run workspace',
      };
    }
    if (ctx.workspace.externalRoots.length > 0) {
      return {
        escalate: true,
        persistable: false,
        reason: `this run can write an external root: ${ctx.workspace.externalRoots.join(', ')}`,
        targetPath: ctx.workspace.externalRoots[0],
      };
    }
    return { escalate: false };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = requireStringInput(input, 'command', 'shell_exec');
    if (ctx.signal?.aborted) { throw new Error('Run cancelled before shell execution.'); }
    if (input.access !== undefined && input.access !== 'scoped' && input.access !== 'full') { throw new Error('Invalid shell access mode.'); }
    if (input.access === 'full') {
      if (!this.device) { throw new Error('Full device execution is unavailable.'); }
      const job = await this.device.start(command, ctx.cwd, {
        ...process.env,
        ...(ctx.workspace ? { MARIFOLD_OUTPUT_DIR: ctx.workspace.outputDir, MARIFOLD_WORK_DIR: ctx.workspace.workDir,
          MARIFOLD_INPUT_DIR: ctx.workspace.inputDir, MARIFOLD_RUN_DIR: ctx.workspace.rootDir } : {}),
      }, undefined, ctx.jobScope);
      return { content: JSON.stringify(job), summary: `started full-access job ${job.id}; retrieve result with shell_job_status` };
    }
    if (!ctx.workspace) {
      return {
        content: 'Marifold refused to run a shell command without an isolated run workspace.',
        summary: `\`${command}\` blocked`,
        isError: true,
      };
    }
    if (/\b(?:python(?:3(?:\.\d+)?)?|pip3?|uv)\b/.test(command)) {
      const environmentError = await ensurePythonEnvironment(ctx.workspace, ctx.outputLimit, ctx.signal);
      if (environmentError) { return environmentError; }
    }
    return runScopedProcess({
      executable: '/bin/sh',
      args: ['-c', command],
      workspace: ctx.workspace,
      cwd: ctx.workspace.cwd,
      network: false,
      outputLimit: ctx.outputLimit,
      signal: ctx.signal,
      successSummary: `ran \`${command}\` in isolated workspace`,
      failureSummary: `\`${command}\` failed in isolated workspace`,
    });
  }
}
