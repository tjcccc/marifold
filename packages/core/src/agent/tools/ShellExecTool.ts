import { execFile } from 'child_process';
import { JSONValue } from '@priest-ai/core';
import { AgentTool, capToolOutput, requireStringInput, ToolExecutionContext, ToolExecutionResult } from '../ToolRegistry';

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

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

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = requireStringInput(input, 'command', 'shell_exec');

    return new Promise<ToolExecutionResult>(resolve => {
      const child = execFile('/bin/sh', ['-c', command], {
        cwd: ctx.cwd,
        timeout: DEFAULT_SHELL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (error) {
          const reason = error.killed
            ? `Command timed out after ${DEFAULT_SHELL_TIMEOUT_MS / 1000}s.`
            : `Command exited with ${(error as { code?: number | string }).code ?? 'an error'}.`;
          parts.push(reason);
          resolve({
            content: capToolOutput(parts.join('\n'), ctx.outputLimit),
            summary: `\`${command}\` failed`,
            isError: true,
          });
          return;
        }
        resolve({
          content: capToolOutput(parts.join('\n') || '(no output)', ctx.outputLimit),
          summary: `ran \`${command}\``,
        });
      });

      ctx.signal?.addEventListener('abort', () => child.kill(), { once: true });
    });
  }
}
