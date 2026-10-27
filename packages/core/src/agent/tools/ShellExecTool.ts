import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { ensurePythonEnvironment, findExecutable, runScopedProcess } from '../ScopedProcess';
import type { DeviceExecution } from '../DeviceExecution';
import { canonicalPath, coversProtectedRoot, isInsideAnyRoot, runGrantFolder, type RunWorkspace } from '../RunWorkspace';
import {
  type AgentTool,
  requireStringInput,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskAssessment,
} from '../ToolRegistry';

const PYTHON_COMMAND = /(?:^|[\s;&|(`])(?:python(?:3(?:\.\d+)?)?|pip3?|uv)(?=\s|$|[;&|)`])/;
const SANDBOX_DENIAL = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES/;
const WRITE_FOLDER_HINT = 'If the command must write a folder outside the working directory and trusted folders, retry it with write_folder set to that folder so the user can approve it; do not switch to access=full for that.';
// The sandbox denies Apple Events, which osascript reports as the target not
// running (-600), an invalid connection (-609) or no authorization (-1743).
const APP_CONTROL_DENIAL = /\((?:-600|-609|-1743)\)/;
const APP_CONTROL_HINT = 'Scoped commands cannot send Apple Events, so they cannot control applications and report a running application as not running. Do not retry this scoped.';

export class ShellExecTool implements AgentTool {
  constructor(private readonly device?: DeviceExecution) {}
  readonly kind = 'shell' as const;
  readonly definition = {
    name: 'shell_exec',
    description: [
      'Run a shell command. Default access=scoped runs in a sandbox without asking: it reads the user home except credential stores, browser profiles and marifold state, writes only the working directory, configured trusted folders and private run directories, has no network, cannot control applications (osascript, AppleScript, JXA), and stops after 60 seconds.',
      'Explicit access=full requires device-local opt-in and approval for every call. It runs with the Marifold account filesystem, network, process, environment and application permissions, not automatic administrator rights.',
      'Full-access commands return a durable job ID immediately; use shell_job_status to retrieve completion. They continue after chat cancellation or bridge disconnection, with a 10-minute limit. Never blindly repeat a command after a lost response; inspect recent jobs first.',
      'When to use: run a focused test, build, formatter, program, or filesystem/process operation that dedicated tools cannot perform.',
      'When NOT to use: scoped text reads/writes or isolated Python package installs that dedicated tools support, or unnecessary demonstration commands. Scoped commands cannot access the network. Use full access only when the requested device operation needs account-level capabilities, such as controlling an application, never as a fallback when a scoped command fails during routine processing.',
      'Scoped access writes only the working directory, configured trusted folders, and private run directories. When the task needs a scoped command to write another existing folder in home, set write_folder to it: the user is asked to approve that folder (creating, editing and deleting inside it), and the command stays sandboxed. Check shell_job_status for the device mode before requesting full access.',
      'For an explicit output file elsewhere, use write_file instead of shell redirection, and copy_file instead of cp or mv to reach files outside those folders (including earlier runs\' outputs).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run. ~ and $HOME refer to the user home. Scoped access retains filesystem sandbox limits.' },
        access: { type: 'string', enum: ['scoped', 'full'], description: 'Default scoped. Full access requires this device to have enabled it locally.' },
        write_folder: { type: 'string', description: 'Scoped only: one existing folder in home (e.g. ~/Documents) the command may also write, after user approval. Omit when the working directory or trusted folders suffice.' },
      },
      required: ['command'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const access = option(input.access);
    const requested = option(input.write_folder);
    const folder = access !== 'full' && typeof requested === 'string' ? ` (may write ${requested})` : '';
    return `${access === 'full' ? '[FULL DEVICE ACCESS; continues after disconnect] ' : ''}run \`${typeof input.command === 'string' ? input.command : '<missing command>'}\`${folder}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    const access = option(input.access);
    if (access !== undefined && access !== 'scoped' && access !== 'full') {
      return { blocked: true, escalate: false, reason: 'Invalid shell access mode.' };
    }
    if (access === 'full') {
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
    const requested = writeFolder(input, ctx.workspace);
    if (requested && 'error' in requested) { return { blocked: true, escalate: false, persistable: false, reason: requested.error }; }
    const extra = requested && !isInsideAnyRoot(requested.folder, ctx.workspace.writeRoots) ? requested.folder : undefined;
    if (ctx.workspace.externalRoots.length > 0) {
      return {
        escalate: true,
        persistable: false,
        reason: `this run can write an external root: ${[...ctx.workspace.externalRoots, ...(extra ? [extra] : [])].join(', ')}`,
        targetPath: ctx.workspace.externalRoots[0],
      };
    }
    if (extra) {
      return {
        escalate: true,
        reason: `lets this sandboxed command create, edit and delete files in ${extra}`,
        targetPath: extra,
        runGrantFolder: extra,
      };
    }
    // Enforced by the sandbox, so routine: no prompt unless shell is denied.
    return { escalate: false, routine: true };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = requireStringInput(input, 'command', 'shell_exec');
    if (ctx.signal?.aborted) { throw new Error('Run cancelled before shell execution.'); }
    const access = option(input.access);
    if (access !== undefined && access !== 'scoped' && access !== 'full') { throw new Error('Invalid shell access mode.'); }
    if (access === 'full') {
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
    // Re-derived from the input rather than trusted from the approval prompt.
    const requested = writeFolder(input, ctx.workspace);
    if (requested && 'error' in requested) {
      return { content: requested.error, summary: `\`${command}\` blocked`, isError: true };
    }
    const workspace: RunWorkspace = requested && !isInsideAnyRoot(requested.folder, ctx.workspace.writeRoots)
      ? { ...ctx.workspace, writeRoots: [...ctx.workspace.writeRoots, requested.folder] }
      : ctx.workspace;
    // Only commands that run Python get the run's environment. Without uv the
    // system python3 still runs; package installs report that uv is missing.
    if (PYTHON_COMMAND.test(command) && findExecutable(process.platform === 'win32' ? 'uv.exe' : 'uv')) {
      const environmentError = await ensurePythonEnvironment(ctx.workspace, ctx.outputLimit, ctx.signal);
      if (environmentError) { return environmentError; }
    }
    const result = await runScopedProcess({
      executable: '/bin/sh',
      args: ['-c', command],
      workspace,
      cwd: workspace.cwd,
      network: false,
      outputLimit: ctx.outputLimit,
      signal: ctx.signal,
      successSummary: `ran \`${command}\` in isolated workspace`,
      failureSummary: `\`${command}\` failed in isolated workspace`,
    });
    if (result.isError && APP_CONTROL_DENIAL.test(result.content)) {
      return { ...result, content: `${result.content}\n${APP_CONTROL_HINT} ${this.device?.mode() === 'full'
        ? 'Controlling an application needs access=full; retry it with that.'
        : 'Full access is off on this device: tell the user that controlling the application needs it, and that they can enable it locally with marifold execution mode full.'}` };
    }
    return result.isError && SANDBOX_DENIAL.test(result.content)
      ? { ...result, content: `${result.content}\n${WRITE_FOLDER_HINT}` }
      : result;
  }
}

/** The extra folder a scoped command asked to write, resolved on this device:
 * an existing folder in home, never home itself, a sensitive or startup root,
 * or a folder containing one. */
function writeFolder(input: Record<string, JSONValue>, workspace: RunWorkspace): { folder: string } | { error: string } | undefined {
  const value = option(input.write_folder);
  if (value === undefined) { return undefined; }
  if (typeof value !== 'string') { return { error: 'write_folder must be a folder path.' }; }
  const raw = value.trim();
  const expanded = raw === '~' ? workspace.userHome : raw.startsWith('~/') ? path.join(workspace.userHome, raw.slice(2)) : path.resolve(workspace.cwd, raw);
  const resolved = canonicalPath(expanded);
  if (!isDirectory(resolved)) { return { error: `write_folder ${raw} is not an existing folder; create it with a file tool first or name its parent.` }; }
  if (isInsideAnyRoot(resolved, workspace.writeRoots)) { return { folder: resolved }; }
  const folder = runGrantFolder(resolved, workspace);
  if (!folder || folder !== resolved || coversProtectedRoot(folder, workspace.userHome)) {
    return { error: `write_folder ${raw} cannot be granted: it must be a folder inside home, not home itself, and not contain private or startup files.` };
  }
  return { folder };
}

/** An optional input, or undefined when left out: models that fill every
 * schema field send "" or null for an option they do not mean to use. */
function option(value: JSONValue | undefined): JSONValue | undefined {
  return value === null || (typeof value === 'string' && !value.trim()) ? undefined : value;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
