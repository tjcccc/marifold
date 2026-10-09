import type { JSONValue } from '@priest-ai/core';
import type { DeviceExecution } from '../DeviceExecution';
import { requireStringInput, type AgentTool, type ToolExecutionContext, type ToolRiskAssessment } from '../ToolRegistry';

export class SudoExecTool implements AgentTool {
  constructor(private readonly device?: DeviceExecution) {}
  readonly kind = 'shell' as const;
  readonly definition = {
    name: 'sudo_exec',
    description: 'Run one exact command as root on the selected device using sudo and a fresh password authorization on the requesting device. When to use: the user requested work that needs administrator privileges and normal shell access is insufficient. Requires target-local full access. The secure approval UI collects the target account password; NEVER request it in chat, ask_user, command arguments, environment, or files. When NOT to use: ordinary user-level work, commands already denied, or OS privacy settings that sudo cannot authorize. Returns a durable job ID; retrieve shell_job_status before reporting success. Never retry a failed or uncertain privileged command automatically. Passwords are not cached by Marifold. The command receives no stdin.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Exact command to run as root. No password, sudo wrapper, or credential prompts.' } }, required: ['command'], additionalProperties: false },
  };
  summarizeCall(input: Record<string, JSONValue>): string { return `[ADMINISTRATOR] run ${typeof input.command === 'string' ? input.command : '<missing command>'}`; }
  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    const command = this.command(input);
    if (this.device?.mode() !== 'full') { return { blocked: true, escalate: true, persistable: false, reason: 'Enable full access locally on the execution device before requesting sudo.' }; }
    return { escalate: true, persistable: false,
      reason: 'Run this exact command as root on the target. Enter the target OS account password only in the secure authorization dialog. Job continues after disconnect.',
      ...(!ctx.sudoResponse ? { sudo: this.device.sudo.create(command) } : {}) };
  }
  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext) {
    const command = this.command(input);
    if (ctx.signal?.aborted) { throw new Error('Run cancelled before sudo execution.'); }
    if (this.device?.mode() !== 'full' || !ctx.sudoResponse) { throw new Error('Sudo requires full access and a fresh secure authorization.'); }
    const password = this.device.sudo.consume(command, ctx.sudoResponse);
    try {
      const job = await this.device.start(command, ctx.cwd, {
        ...process.env,
        ...(ctx.workspace ? { MARIFOLD_OUTPUT_DIR: ctx.workspace.outputDir, MARIFOLD_WORK_DIR: ctx.workspace.workDir, MARIFOLD_INPUT_DIR: ctx.workspace.inputDir } : {}),
      }, password, ctx.jobScope);
      return { content: JSON.stringify(job), summary: `started administrator job ${job.id}; retrieve shell_job_status` };
    } finally { password.fill(0); }
  }
  private command(input: Record<string, JSONValue>): string {
    if (Object.keys(input).some(key => key !== 'command')) { throw new Error('sudo_exec accepts only a command; credentials must use the secure dialog.'); }
    return requireStringInput(input, 'command', 'sudo_exec');
  }
}
