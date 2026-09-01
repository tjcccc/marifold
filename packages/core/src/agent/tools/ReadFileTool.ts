import * as fs from 'fs';
import { JSONValue } from '@priest-ai/core';
import {
  isInsideAnyRoot,
  isExactPath,
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

export interface ReadFileToolOptions {
  /** Fail closed outside the run's declared read roots/exact files. Used by
   * SkillApps, whose model must never request an interactive wider grant. */
  strictWorkspace?: boolean;
}

export class ReadFileTool implements AgentTool {
  constructor(private readonly options: ReadFileToolOptions = {}) {}

  readonly kind = 'read' as const;
  readonly definition = {
    name: 'read_file',
    description: [
      'Read one local UTF-8 text file with bounded output, or list one known directory level.',
      'When to use: inspect an exact path, read source or instructions before acting, or confirm a written file.',
      'When NOT to use: broad content search, binary-file extraction, facts already available in context, or speculative filesystem exploration.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute, relative to the working directory, or ~/ relative to the user home.' },
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
    if (isInsideAnyRoot(target, ctx.workspace.readRoots) || isExactPath(target, ctx.workspace.readOnlyFiles)) {
      return this.options.strictWorkspace ? { escalate: false, trusted: true } : { escalate: false };
    }
    if (this.options.strictWorkspace) {
      return {
        escalate: false,
        blocked: true,
        reason: `reading ${target} is outside this SkillApp's declared read permissions`,
        targetPath: target,
      };
    }
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
    if (this.options.strictWorkspace && ctx.workspace
      && !isInsideAnyRoot(target, ctx.workspace.readRoots)
      && !isExactPath(target, ctx.workspace.readOnlyFiles)) {
      return {
        content: `Could not read ${target}: path is outside this SkillApp's declared read permissions.`,
        summary: `blocked read outside SkillApp permissions`,
        isError: true,
      };
    }
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
