import * as fs from 'fs';
import { JSONValue } from '@priest-ai/core';
import {
  isInsideAnyRoot,
  isOutsideUserHome,
  isSensitiveHostPath,
  resolveToolPath,
} from '../RunWorkspace';
import {
  AgentTool,
  capToolOutput,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

export class ReadFileTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'read_file',
    description: 'Read a local text file. Returns the file content, truncated when very large.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      },
      required: ['path'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `read ${typeof input.path === 'string' ? input.path : '<missing path>'}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (typeof input.path !== 'string' || !ctx.workspace) return { escalate: false };
    const target = resolveToolPath(input.path, ctx.workspace, ctx.cwd);
    if (isInsideAnyRoot(target, ctx.workspace.readRoots)) return { escalate: false };
    const nonPersistable = isOutsideUserHome(target, ctx.workspace) || isSensitiveHostPath(target, ctx.workspace);
    return {
      escalate: true,
      persistable: !nonPersistable,
      reason: nonPersistable
        ? `reading ${target} is outside this run's persistent filesystem scope`
        : `reading ${target} is outside this run's working and trusted folders`,
      targetPath: target,
    };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const target = resolveToolPath(
      requireStringInput(input, 'path', 'read_file'),
      ctx.workspace,
      ctx.cwd,
    );
    let content: string;
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(target).sort((a, b) => a.localeCompare(b));
        return {
          content: entries.join('\n'),
          summary: `listed ${entries.length} entries in ${target}`,
        };
      }
      content = fs.readFileSync(target, 'utf-8');
    } catch (error) {
      return {
        content: `Could not read ${target}: ${error instanceof Error ? error.message : String(error)}`,
        summary: `failed to read ${target}`,
        isError: true,
      };
    }
    return {
      content: capToolOutput(content, ctx.outputLimit),
      summary: `read ${formatBytes(Buffer.byteLength(content, 'utf-8'))} from ${target}`,
    };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
