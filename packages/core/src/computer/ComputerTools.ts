import type { JSONValue } from '@priest-ai/core';
import { canonicalPath, isDeniedRunPath, isInside, isSensitiveHostPath, resolveToolPath, sensitiveHostRoots } from '../agent/RunWorkspace';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import {
  type AgentTool,
  capToolOutput,
  requireStringInput,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskAssessment,
} from '../agent/ToolRegistry';
import type { AgentComputer } from './AgentComputer';
import { execInComputer, getFromComputer, putIntoComputer, writeComputerFile } from './AgentComputerFiles';

const ABOUT = 'the agent\'s own Linux computer (Ubuntu 24.04, account "agent" with passwordless sudo, home /home/agent). It is isolated: it cannot reach the user\'s devices, files, or local network; internet access goes through an HTTP(S) proxy that apt, pip, npm, curl and git over HTTPS already use. Nothing there needs approval.';
const TRUSTED: ToolRiskAssessment = { escalate: false, trusted: true };

function failure(error: unknown, summary: string): ToolExecutionResult {
  return { content: error instanceof Error ? error.message : String(error), summary, isError: true };
}

/** Runs commands on the profile's computer: installs, builds, scripts, long jobs. */
export class ComputerExecTool implements AgentTool {
  readonly kind = 'shell' as const;
  readonly definition = {
    name: 'computer_exec',
    description: `Run a bash command on ${ABOUT} Use sudo freely there (for example sudo apt-get install -y ...). Output is combined stdout/stderr. For servers or long jobs, start them with nohup ... & and check later.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command, run in a login shell from /home/agent.' },
        timeout_seconds: { type: 'number', description: 'Stop the command after this many seconds (default 300, maximum 3600).' },
      },
      required: ['command'],
    },
  };
  constructor(private readonly computer: AgentComputer, private readonly profile: string) {}
  summarizeCall(input: Record<string, JSONValue>): string {
    return `on the agent computer: ${typeof input.command === 'string' ? input.command.slice(0, 120) : '<missing command>'}`;
  }
  assessRisk(): ToolRiskAssessment { return TRUSTED; }
  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = requireStringInput(input, 'command', this.definition.name);
    const requested = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : 300;
    const timeoutSeconds = Math.max(1, Math.min(3600, Math.round(requested)));
    try {
      const result = await execInComputer(this.computer, this.profile, command, { timeoutSeconds, signal: ctx.signal, maxOutput: 1024 * 1024 });
      const status = result.timedOut ? `timed out after ${timeoutSeconds}s` : `exit code ${result.exitCode}`;
      return {
        content: capToolOutput(`${result.output}${result.output.endsWith('\n') || !result.output ? '' : '\n'}[${status}]`, ctx.outputLimit),
        summary: status,
        isError: result.exitCode !== 0,
      };
    } catch (error) {
      return failure(error, 'agent computer unavailable');
    }
  }
}

export class ComputerWriteFileTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'computer_write_file',
    description: `Write a UTF-8 text file on ${ABOUT} Parent folders are created. To read files there, use computer_exec (cat, head, ls).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path on the agent computer; relative paths start at /home/agent.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  };
  constructor(private readonly computer: AgentComputer, private readonly profile: string) {}
  summarizeCall(input: Record<string, JSONValue>): string {
    return `write ${typeof input.content === 'string' ? input.content.length : 0} chars to ${String(input.path)} on the agent computer`;
  }
  assessRisk(): ToolRiskAssessment { return TRUSTED; }
  async execute(input: Record<string, JSONValue>): Promise<ToolExecutionResult> {
    const target = requireStringInput(input, 'path', this.definition.name);
    const content = typeof input.content === 'string' ? input.content : '';
    try {
      await writeComputerFile(this.computer, this.profile, target, content);
      return { content: `Wrote ${Buffer.byteLength(content)} bytes to ${target} on the agent computer.`, summary: 'written on the agent computer' };
    } catch (error) {
      return failure(error, 'write failed');
    }
  }
}

/** Gives the computer a file or folder from this device. Reading it follows this
 * device's ordinary read approvals; the computer is never handed a path itself. */
export class ComputerPutTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'computer_put',
    description: `Copy a file or folder from the user's device into ${ABOUT} Reading the source on the user's device may ask the user for approval. This is the only way the computer receives the user's files.`,
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'File or folder on the user\'s device (absolute, ~/..., or relative to the working directory).' },
        destination: { type: 'string', description: 'Destination on the agent computer. For a file: the target path, or a folder ending in /. For a folder: the folder to place it in. Default: /home/agent/inbox/.' },
      },
      required: ['source'],
    },
  };
  private readonly reader = new ReadFileTool();
  constructor(private readonly computer: AgentComputer, private readonly profile: string) {}
  summarizeCall(input: Record<string, JSONValue>): string {
    return `give the agent computer ${String(input.source)}`;
  }
  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (typeof input.source !== 'string' || !ctx.workspace) { return { escalate: false, blocked: true, reason: 'computer_put needs a source path in a run workspace' }; }
    // Stricter than read_file: credentials and Marifold state never go to a
    // sudo-capable, internet-connected machine, even with approval.
    const target = canonicalPath(resolveToolPath(input.source, ctx.workspace, ctx.cwd));
    const roots = [...sensitiveHostRoots(ctx.workspace.userHome), ...(ctx.workspace.deniedRoots ?? [])];
    if (!isInside(target, ctx.workspace.rootDir) && roots.some(root => isInside(target, root) || isInside(root, target))) {
      return { escalate: false, blocked: true, persistable: false, reason: `${target} is or contains credentials or Marifold state, which never go to the agent computer` };
    }
    return this.reader.assessRisk({ path: input.source }, ctx);
  }
  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const workspace = ctx.workspace;
    if (!workspace) { return failure('computer_put needs a run workspace.', 'unavailable'); }
    const source = resolveToolPath(requireStringInput(input, 'source', this.definition.name), workspace, ctx.cwd);
    const destination = typeof input.destination === 'string' && input.destination.trim() ? input.destination.trim() : '/home/agent/inbox/';
    try {
      const result = await putIntoComputer(this.computer, this.profile, source, destination, (entry) => {
        if (isDeniedRunPath(entry, workspace)) { return 'contains device-local Marifold or other-workspace state'; }
        if (isSensitiveHostPath(entry, workspace)) { return 'contains credentials or other sensitive account data'; }
        return undefined;
      }, ctx.signal);
      return {
        content: `Copied ${result.files} file(s), ${result.bytes} bytes, from ${source} to ${result.destination} on the agent computer.`,
        summary: `${result.files} file(s) to the agent computer`,
      };
    } catch (error) {
      return failure(error, 'copy failed');
    }
  }
}

/** Brings a result back: the file becomes a run artifact the user can download. */
export class ComputerGetTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'computer_get',
    description: `Bring one file back from ${ABOUT} The file becomes a downloadable result of this run. To return a folder, archive it first with computer_exec (tar or zip).`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File on the agent computer; relative paths start at /home/agent.' } },
      required: ['path'],
    },
  };
  constructor(private readonly computer: AgentComputer, private readonly profile: string) {}
  summarizeCall(input: Record<string, JSONValue>): string {
    return `bring back ${String(input.path)} from the agent computer`;
  }
  assessRisk(): ToolRiskAssessment { return TRUSTED; }
  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const outputDir = ctx.workspace?.outputDir;
    if (!outputDir) { return failure('computer_get needs a run with an output folder.', 'unavailable'); }
    try {
      const result = await getFromComputer(this.computer, this.profile, requireStringInput(input, 'path', this.definition.name), outputDir, ctx.signal);
      return { content: `Saved ${result.bytes} bytes as the run result ${result.file}.`, summary: 'result from the agent computer' };
    } catch (error) {
      return failure(error, 'copy failed');
    }
  }
}

/** "Your computer", "the agent computer", "你的电脑": the agent's own computer,
 * not the user's device ("my computer"). Such requests run on the host. */
export function mentionsAgentComputer(text: string): boolean {
  return /\b(?:your|its|own|agent['’]?s?)\s+(?:own\s+)?(?:linux\s+)?(?:computer|machine|vm|sandbox)\b|\bcomputer_(?:exec|put|get|write_file)\b/i.test(text)
    || /(?:你的|你自己的|自己的|智能体的?|代理的?)\s*(?:电脑|计算机|机器|虚拟机|沙盒)/.test(text);
}

/** The tools for a profile's computer, or none when it has no computer. */
export function agentComputerTools(computer: AgentComputer, profile: string): AgentTool[] {
  if (!computer.has(profile)) { return []; }
  return [
    new ComputerExecTool(computer, profile),
    new ComputerWriteFileTool(computer, profile),
    new ComputerPutTool(computer, profile),
    new ComputerGetTool(computer, profile),
  ];
}
