import { JSONValue } from '@priest-ai/core';
import { ensurePythonEnvironment, runScopedProcess } from '../ScopedProcess';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

export class ShellExecTool implements AgentTool {
  readonly kind = 'shell' as const;
  readonly definition = {
    name: 'shell_exec',
    description: 'Run a shell command in the working directory and return stdout/stderr. Commands time out after 60 seconds.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `run \`${typeof input.command === 'string' ? input.command : '<missing command>'}\``;
  }

  assessRisk(_input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
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
    if (!ctx.workspace) {
      return {
        content: 'Marifold refused to run a shell command without an isolated run workspace.',
        summary: `\`${command}\` blocked`,
        isError: true,
      };
    }
    if (/\b(?:python(?:3(?:\.\d+)?)?|pip3?|uv)\b/.test(command)) {
      const environmentError = await ensurePythonEnvironment(ctx.workspace, ctx.outputLimit, ctx.signal);
      if (environmentError) return environmentError;
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
