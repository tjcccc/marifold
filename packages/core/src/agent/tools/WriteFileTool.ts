import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { expandHome } from '../../workspace/WorkspacePaths';
import { assessFileWrite, trashPreviousVersion } from '../FilePolicy';
import { canonicalPath, isInside, resolveToolPath } from '../RunWorkspace';
import { type AgentTool, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../ToolRegistry';
import { formatBytes } from './ReadFileTool';

export class WriteFileTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'write_file',
    description: [
      'Create or fully overwrite a local text file, creating parent directories as needed. An overwritten file\'s previous version goes to the Trash.',
      'When to use: the objective requires a concrete file at an explicit path or a complete small/generated file.',
      'When NOT to use: merely answering a question, speculative files the user did not request, or shell output that can remain in the response.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute, relative to the working directory, or ~/ relative to the user home.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const target = typeof input.path === 'string' ? input.path : '<missing path>';
    const size = typeof input.content === 'string' ? formatBytes(Buffer.byteLength(input.content, 'utf-8')) : '?';
    return `write ${size} to ${target}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (typeof input.path !== 'string') { return { escalate: false }; }
    const target = canonicalPath(resolveToolPath(input.path, ctx.workspace, ctx.cwd));
    if (ctx.workspace) { return assessFileWrite(target, ctx.workspace); }
    // A write inside a trusted folder is auto-approved — checked before the
    // workspace so a trusted folder set as cwd (e.g. a channel's outbox) is
    // silent, not merely non-escalated (which still asks under write=ask).
    if (isInsideAny(target, ctx.trustedFolders)) { return { escalate: false, trusted: true }; }
    if (isInsideWorkspace(target, ctx.cwd)) { return { escalate: false }; }
    return { escalate: true, reason: `target ${target} is outside the working directory ${ctx.cwd}`, targetPath: target };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const target = resolveToolPath(
      requireStringInput(input, 'path', 'write_file'),
      ctx.workspace,
      ctx.cwd,
    );
    if (ctx.workspace) {
      const policy = assessFileWrite(canonicalPath(target), ctx.workspace);
      if (policy.blocked) { return { content: `Refused to write ${target}: ${policy.reason}.`, summary: `refused write to ${target}`, isError: true }; }
    }
    const content = typeof input.content === 'string' ? input.content : '';
    let previous: string | undefined;
    try {
      // An overwrite is undoable: the old content goes to the Trash first.
      // The run's own scratch files are not worth keeping.
      if (ctx.workspace && !isInside(target, ctx.workspace.rootDir)) { previous = await trashPreviousVersion(target, ctx.workspace.userHome); }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } catch (error) {
      return {
        content: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
        summary: `failed to write ${target}`,
        isError: true,
      };
    }
    const size = formatBytes(Buffer.byteLength(content, 'utf-8'));
    return {
      content: `Wrote ${size} to ${target}.${previous ? ` The previous version is in ${previous}.` : ''}`,
      summary: `wrote ${size} to ${target}`,
    };
  }
}

export function isInsideWorkspace(target: string, cwd: string): boolean {
  // Compare real locations so a symlink inside a trusted folder cannot carry
  // its approval to a destination outside it.
  const relative = path.relative(canonicalPath(cwd), canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** True when `target` is inside any of `roots` (each treated like a workspace). */
export function isInsideAny(target: string, roots?: string[]): boolean {
  return (roots ?? []).some(root => isInsideWorkspace(target, expandHome(root)));
}
