import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { assessFileRead, assessFileWrite, combineRisks, trashPreviousVersion } from '../FilePolicy';
import { canonicalPath, isInside, resolveToolPath } from '../RunWorkspace';
import { type AgentTool, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../ToolRegistry';
import { formatBytes, ReadFileTool } from './ReadFileTool';
import { WriteFileTool } from './WriteFileTool';

/**
 * Copies one file, text or binary, inside the Marifold process. Unlike `cp`
 * in shell_exec, whose sandbox is fixed to the run's own folders, it is
 * checked like a read of the source plus a write of the destination (see
 * FilePolicy).
 */
export class CopyFileTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'copy_file',
    description: [
      'Copy one file (text or binary) to another path on this device, creating parent folders as needed.',
      'When to use: copying a file the user named, or an earlier run\'s output, to a folder such as ~/tempfiles. Prefer it over cp in shell_exec, whose sandbox cannot reach folders outside this run.',
      'A destination that is an existing folder receives the file under its own name. A replaced file\'s previous version goes to the Trash.',
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
    const source = readSide(this.read.assessRisk({ path: input.source }, ctx));
    const destination = this.write.assessRisk({ path: destinationPath(input.source, input.destination, ctx) }, ctx);
    return combineRisks(source, destination);
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const source = resolveToolPath(requireStringInput(input, 'source', 'copy_file'), ctx.workspace, ctx.cwd);
    const target = destinationPath(source, requireStringInput(input, 'destination', 'copy_file'), ctx);
    if (ctx.workspace) {
      const policy = combineRisks(readSide(assessFileRead(canonicalPath(source), ctx.workspace)), assessFileWrite(canonicalPath(target), ctx.workspace));
      if (policy.blocked) { return { content: `Refused to copy ${source} to ${target}: ${policy.reason}.`, summary: `refused copy to ${target}`, isError: true }; }
    }
    let previous: string | undefined;
    try {
      if (!fs.statSync(source).isFile()) { throw new Error('the source is not a file'); }
      if (ctx.workspace && !isInside(target, ctx.workspace.rootDir)) { previous = await trashPreviousVersion(target, ctx.workspace.userHome); }
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
    return { content: `Copied ${size} from ${source} to ${target}.${previous ? ` The replaced file's previous version is in ${previous}.` : ''}`, summary: `copied ${size} to ${target}` };
  }
}

/** A source read that needs no prompt leaves the copy as routine as its
 * destination; the copy itself is a write. */
function readSide(risk: ToolRiskAssessment): ToolRiskAssessment {
  return risk.blocked || risk.escalate ? risk : { escalate: false, routine: true };
}

/** The destination file: inside the destination when it is an existing folder. */
function destinationPath(source: string, destination: string, ctx: ToolExecutionContext): string {
  const resolved = resolveToolPath(destination, ctx.workspace, ctx.cwd);
  try {
    if (fs.statSync(resolved).isDirectory()) { return path.join(resolved, path.basename(source)); }
  } catch { /* a new file */ }
  return resolved;
}
