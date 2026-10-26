import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { assessFileRemoval, assessFileWrite, combineRisks, entryExists, entryPath, moveToTrash } from '../FilePolicy';
import { canonicalPath, resolveToolPath, type RunWorkspace } from '../RunWorkspace';
import { type AgentTool, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../ToolRegistry';

const PATH_DESCRIPTION = 'Absolute, relative to the working directory, or ~/ relative to the user home.';
const NO_WORKSPACE: ToolRiskAssessment = { escalate: false, blocked: true, persistable: false, reason: 'file management needs a run workspace' };

function stringInput(input: Record<string, JSONValue>, key: string): string | undefined {
  return typeof input[key] === 'string' ? input[key] : undefined;
}

function refused(action: string, risk: ToolRiskAssessment): ToolExecutionResult {
  return { content: `Refused to ${action}: ${risk.reason ?? 'blocked by policy'}.`, summary: `refused to ${action}`, isError: true };
}

function failed(action: string, error: unknown): ToolExecutionResult {
  return { content: `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`, summary: `failed to ${action}`, isError: true };
}

/** Creates a folder (and missing parents). */
export class MakeDirectoryTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'make_directory',
    description: [
      'Create a folder on this device, including missing parent folders. An existing folder is left as it is.',
      'Prefer it over mkdir in shell_exec for ordinary file organization.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: `Folder to create. ${PATH_DESCRIPTION}` } },
      required: ['path'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `create folder ${stringInput(input, 'path') ?? '<missing path>'}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    const value = stringInput(input, 'path');
    if (value === undefined) { return { escalate: false }; }
    if (!ctx.workspace) { return NO_WORKSPACE; }
    return assessFileWrite(canonicalPath(resolveToolPath(value, ctx.workspace, ctx.cwd)), ctx.workspace);
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!ctx.workspace) { return refused('create the folder', NO_WORKSPACE); }
    const target = resolveToolPath(requireStringInput(input, 'path', 'make_directory'), ctx.workspace, ctx.cwd);
    const risk = assessFileWrite(canonicalPath(target), ctx.workspace);
    if (risk.blocked) { return refused(`create ${target}`, risk); }
    try {
      if (entryExists(target)) {
        if (!fs.statSync(target).isDirectory()) { throw new Error('a file with that name already exists'); }
        return { content: `${target} already exists.`, summary: `folder ${target} exists` };
      }
      fs.mkdirSync(target, { recursive: true });
    } catch (error) {
      return failed(`create ${target}`, error);
    }
    return { content: `Created folder ${target}.`, summary: `created folder ${target}` };
  }
}

/** Renames or moves a file or folder without replacing anything. */
export class MovePathTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'move_path',
    description: [
      'Rename or move one file or folder on this device, creating missing destination folders. The destination is the complete new path and must not exist; nothing is replaced.',
      'Prefer it over mv in shell_exec. To replace an existing item, trash it with trash_path first.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: `Existing file or folder. ${PATH_DESCRIPTION}` },
        destination: { type: 'string', description: `New path, including the new name. ${PATH_DESCRIPTION}` },
      },
      required: ['source', 'destination'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `move ${stringInput(input, 'source') ?? '<missing source>'} to ${stringInput(input, 'destination') ?? '<missing destination>'}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    const source = stringInput(input, 'source');
    const destination = stringInput(input, 'destination');
    if (source === undefined || destination === undefined) { return { escalate: false }; }
    if (!ctx.workspace) { return NO_WORKSPACE; }
    return moveRisk(resolveToolPath(source, ctx.workspace, ctx.cwd), resolveToolPath(destination, ctx.workspace, ctx.cwd), ctx.workspace);
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!ctx.workspace) { return refused('move', NO_WORKSPACE); }
    const source = resolveToolPath(requireStringInput(input, 'source', 'move_path'), ctx.workspace, ctx.cwd);
    const destination = resolveToolPath(requireStringInput(input, 'destination', 'move_path'), ctx.workspace, ctx.cwd);
    const risk = moveRisk(source, destination, ctx.workspace);
    if (risk.blocked) { return refused(`move ${source}`, risk); }
    try {
      const from = fs.lstatSync(source);
      if (entryExists(destination)) {
        // A case-only rename on a case-insensitive volume sees itself.
        const to = fs.lstatSync(destination);
        if (to.ino !== from.ino || to.dev !== from.dev) { throw new Error(`${destination} already exists; nothing was replaced`); }
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        return failed(`move ${source}`, new Error('the destination is on another volume; copy it with copy_file, then trash the original'));
      }
      return failed(`move ${source}`, error);
    }
    return { content: `Moved ${source} to ${destination}.`, summary: `moved to ${destination}` };
  }
}

function moveRisk(source: string, destination: string, workspace: RunWorkspace): ToolRiskAssessment {
  return combineRisks(assessFileRemoval(entryPath(source), workspace), assessFileWrite(canonicalPath(destination), workspace));
}

/** Moves a file or folder to the Trash instead of deleting it. */
export class TrashPathTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'trash_path',
    description: [
      'Move one file or folder on this device to the Trash, where the user can restore it. Nothing is deleted permanently.',
      'Use it whenever the user asks to delete or remove files; prefer it over rm in shell_exec.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: `File or folder to trash. ${PATH_DESCRIPTION}` } },
      required: ['path'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `move ${stringInput(input, 'path') ?? '<missing path>'} to the Trash`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    const value = stringInput(input, 'path');
    if (value === undefined) { return { escalate: false }; }
    if (!ctx.workspace) { return NO_WORKSPACE; }
    return assessFileRemoval(entryPath(resolveToolPath(value, ctx.workspace, ctx.cwd)), ctx.workspace);
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!ctx.workspace) { return refused('trash', NO_WORKSPACE); }
    const target = resolveToolPath(requireStringInput(input, 'path', 'trash_path'), ctx.workspace, ctx.cwd);
    const risk = assessFileRemoval(entryPath(target), ctx.workspace);
    if (risk.blocked) { return refused(`trash ${target}`, risk); }
    let location: string;
    try {
      location = await moveToTrash(target, ctx.workspace.userHome);
    } catch (error) {
      return failed(`trash ${target}`, error);
    }
    return { content: `Moved ${target} to ${location}.`, summary: `trashed ${target}` };
  }
}

export function fileManagementTools(): AgentTool[] {
  return [new MakeDirectoryTool(), new MovePathTool(), new TrashPathTool()];
}
