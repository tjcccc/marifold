import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { isDeniedRunPath, isProtectedSystemWrite, isReadOnlyStatePath, resolveToolPath } from '../RunWorkspace';
import { type AgentTool, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../ToolRegistry';
import { formatBytes, ReadFileTool } from './ReadFileTool';
import { WriteFileTool } from './WriteFileTool';

/**
 * Copies one file, text or binary, inside the Marifold process. Unlike `cp`
 * in shell_exec, whose sandbox is fixed to the run's own folders, it is
 * checked like a read of the source plus a write of the destination, so the
 * same approvals, run grants and trusted folders apply.
 */
export class CopyFileTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'copy_file',
    description: [
      'Copy one file (text or binary) to another path on this device, creating parent folders as needed.',
      'When to use: copying a file the user named, or an earlier run\'s output, to a folder such as ~/tempfiles. Prefer it over cp in shell_exec, whose sandbox cannot reach folders outside this run.',
      'A destination that is an existing folder receives the file under its own name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'File to copy: absolute, relative to the working directory, or ~/ relative to the user home.' },
        destination: { type: 'string', description: 'Destination file path, or an existing folder.' },
      },
      required: ['source', 'destination'],
    },
  };

  private readonly read = new ReadFileTool();
  private readonly write = new WriteFileTool();

  summarizeCall(input: Record<string, JSONValue>): string {
    const source = typeof input.source === 'string' ? input.source : '<missing source>';
    const destination = typeof input.destination === 'string' ? input.destination : '<missing destination>';
    return `copy ${source} to ${destination}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (typeof input.source !== 'string' || typeof input.destination !== 'string') { return { escalate: false }; }
    const source = this.read.assessRisk({ path: input.source }, ctx);
    const target = destinationPath(input.source, input.destination, ctx);
    const destination = this.write.assessRisk({ path: target }, ctx);
    for (const risk of [source, destination]) {
      if (risk.blocked) { return risk; }
    }
    const escalate = source.escalate || destination.escalate;
    if (!escalate) {
      return source.trusted && destination.trusted ? { escalate: false, trusted: true } : { escalate: false };
    }
    const reason = [source, destination].filter(risk => risk.escalate && risk.reason).map(risk => risk.reason).join('; ');
    const persistable = source.persistable !== false && destination.persistable !== false;
    // One folder can be granted or trusted per approval, and the grant is a
    // write grant, so it is offered only when the destination alone escalates.
    if (!source.escalate) {
      return {
        escalate: true,
        persistable,
        reason,
        ...(destination.targetPath ? { targetPath: destination.targetPath } : {}),
        ...(destination.runGrantFolder ? { runGrantFolder: destination.runGrantFolder } : {}),
      };
    }
    return { escalate: true, persistable, reason };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const source = resolveToolPath(requireStringInput(input, 'source', 'copy_file'), ctx.workspace, ctx.cwd);
    const target = destinationPath(source, requireStringInput(input, 'destination', 'copy_file'), ctx);
    if (ctx.workspace && (isDeniedRunPath(source, ctx.workspace) || isDeniedRunPath(target, ctx.workspace))) {
      return { content: 'Path is isolated from this workspace.', summary: 'blocked workspace state access', isError: true };
    }
    if (ctx.workspace && (isReadOnlyStatePath(target, ctx.workspace) || isProtectedSystemWrite(target, ctx.workspace))) {
      return { content: `Refused to write ${target}.`, summary: `refused protected write to ${target}`, isError: true };
    }
    try {
      if (!fs.statSync(source).isFile()) { throw new Error('the source is not a file'); }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } catch (error) {
      return {
        content: `Could not copy ${source} to ${target}: ${error instanceof Error ? error.message : String(error)}`,
        summary: `failed to copy ${source}`,
        isError: true,
      };
    }
    const size = formatBytes(fs.statSync(target).size);
    return { content: `Copied ${size} from ${source} to ${target}.`, summary: `copied ${size} to ${target}` };
  }
}

/** The destination file: inside the destination when it is an existing folder. */
function destinationPath(source: string, destination: string, ctx: ToolExecutionContext): string {
  const resolved = resolveToolPath(destination, ctx.workspace, ctx.cwd);
  try {
    if (fs.statSync(resolved).isDirectory()) { return path.join(resolved, path.basename(source)); }
  } catch { /* a new file */ }
  return resolved;
}
