import { createArtifactPreview } from '../agent/ArtifactPreview';
import { artifactReadLength } from './WorkspaceArtifactTransfer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { digest, identifier, randomId, record } from '@marifold/workspace-protocol';
import type { JSONValue } from '@priest-ai/core';
import { createRunWorkspace, type RunWorkspace } from '../agent/RunWorkspace';
import { listRunArtifacts, resolveRunArtifact } from '../agent/RunArtifacts';
import { ToolRegistry, type AgentTool, type ToolExecutionContext } from '../agent/ToolRegistry';
import { InspectAttachmentTool } from '../agent/tools/InspectAttachmentTool';
import { ReadAttachmentTool } from '../agent/tools/ReadAttachmentTool';
import { SearchAttachmentTool } from '../agent/tools/SearchAttachmentTool';
import { ReadFileTool } from '../agent/tools/ReadFileTool';
import { WriteFileTool } from '../agent/tools/WriteFileTool';
import { ShellExecTool } from '../agent/tools/ShellExecTool';
import { marifoldHome } from './WorkspacePaths';
import type { WorkspaceOperationContext } from './WorkspaceManager';
import type { MarifoldAgentConfig } from '../agent/ApprovalPolicy';

export function executionTools(): AgentTool[] {
  return [
    new InspectAttachmentTool(),
    new ReadAttachmentTool(),
    new SearchAttachmentTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new ShellExecTool(),
  ];
}
interface Execution {
  workspace: RunWorkspace;
  abort: AbortController;
  lease: number;
  grants: Map<string, { hash: string; expires: number }>;
  completed: boolean;
}
/** A device owns its own capability construction. Host paths, trusted folders,
 * shell environments, and credentials are never accepted as grants over RPC. */
export class WorkspaceExecutor {
  private runs = new Map<string, Execution>();
  private registry = new ToolRegistry();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly config: () => MarifoldAgentConfig,
    private readonly runsDir?: string,
    private readonly protectedPaths: string[] = [],
  ) {
    for (const tool of executionTools()) this.registry.register(tool);
    this.timer = setInterval(() => {
      for (const [id, run] of this.runs)
        if (run.lease < Date.now()) {
          run.abort.abort();
          this.runs.delete(id);
        }
    }, 5000);
    this.timer.unref();
  }
  close(): void {
    clearInterval(this.timer);
    for (const run of this.runs.values()) run.abort.abort();
    this.runs.clear();
  }
  cancelWorkspace(workspaceId: string): void {
    for (const [key, run] of this.runs)
      if (key.startsWith(`${workspaceId}:`)) {
        run.abort.abort();
        this.runs.delete(key);
      }
  }
  async handle(operation: string, value: unknown, context: WorkspaceOperationContext): Promise<unknown> {
    const b = record(value);
    const runId = identifier(b.runId);
    const key = `${context.workspaceId}:${runId}`;
    // Completed output is read-only and recoverable after a guest restart. Never
    // reconstruct execution capabilities or grants from an on-disk run directory.
    if (operation === 'executor.artifact') {
      const artifact = resolveRunArtifact(
        `ws_${identifier(context.workspaceId)}_${runId}`,
        identifier(b.artifactId),
        this.runsDir ?? path.join(marifoldHome(), 'runs'),
      );
      if (b.metadata === true) return { available: Boolean(artifact) };
      if (!artifact) throw new Error('Artifact is unavailable.');
      if (b.preview === true) return { data: (await createArtifactPreview(artifact)).toString('base64') };
      const offset = b.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size)
        throw new Error('Invalid artifact offset.');
      const fd = fs.openSync(artifact.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(Math.min(artifactReadLength(b.length), artifact.size - offset));
        const n = fs.readSync(fd, bytes, 0, bytes.length, offset);
        return { data: bytes.subarray(0, n).toString('base64'), size: artifact.size };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (operation === 'executor.prepare') {
      if (this.runs.has(key)) throw new Error('Execution already prepared.');
      if (this.runs.size >= 50) throw new Error('Execution capacity reached.');
      if (Array.isArray(b.images) && b.images.some((image) => !image || typeof image !== 'object' || 'path' in image))
        throw new Error('Remote image inputs must carry bytes or URLs, never device paths.');
      const config = this.config();
      const workspace = createRunWorkspace({
        deniedRoots: this.protectedPaths,
        id: `ws_${context.workspaceId}_${runId}`,
        cwd: typeof b.cwd === 'string' ? b.cwd : undefined,
        trustedFolders: config.trustedFolders,
        files: Array.isArray(b.files) ? (b.files as never) : undefined,
        images: Array.isArray(b.images) ? (b.images as never) : undefined,
        ...(this.runsDir ? { runsDir: this.runsDir } : {}),
      });
      this.runs.set(key, {
        workspace,
        abort: new AbortController(),
        lease: Date.now() + 45000,
        grants: new Map(),
        completed: false,
      });
      return workspace;
    }
    const run = this.runs.get(key);
    if (!run) throw new Error('Execution is unavailable or its lease expired. Start a new run explicitly.');
    if (operation === 'executor.cancel') {
      run.abort.abort();
      return { cancelled: true };
    }
    if (operation === 'executor.lease') {
      if (!run.completed && !run.abort.signal.aborted) run.lease = Date.now() + 45000;
      return { active: !run.abort.signal.aborted };
    }
    if (operation === 'executor.artifacts') {
      run.completed = true;
      run.lease = Date.now() + 24 * 60 * 60 * 1000;
      return listRunArtifacts(run.workspace);
    }
    if (run.completed || run.abort.signal.aborted) throw new Error('Execution has ended.');
    const tool = this.registry.get(String(b.tool));
    if (!tool || tool.kind === 'interaction') throw new Error('Unsupported execution tool.');
    const input = record(b.input) as Record<string, JSONValue>;
    const toolContext: ToolExecutionContext = {
      workspace: run.workspace,
      cwd: run.workspace.cwd,
      trustedFolders: this.config().trustedFolders,
      outputLimit: this.config().toolOutputLimit,
      signal: run.abort.signal,
    };
    const risk = (await tool.assessRisk?.(input, toolContext)) ?? { escalate: false };
    const blocked = risk.blocked || (!risk.trusted && this.config().approval[tool.kind] === 'deny');
    const hash = digest(JSON.stringify([tool.definition.name, input]));
    if (operation === 'executor.assess') {
      const grant = randomId();
      for (const [id, g] of run.grants) if (g.expires < Date.now()) run.grants.delete(id);
      if (run.grants.size >= 128) throw new Error('Too many outstanding execution grants.');
      if (!blocked) run.grants.set(grant, { hash, expires: Date.now() + 6 * 60 * 1000 });
      return {
        ...risk,
        blocked,
        grant,
        persistable: false,
        trusted: false,
        escalate: true,
        reason: blocked
          ? (risk.reason ?? 'Denied by execution device policy.')
          : (risk.reason ?? 'Approve this call on the selected device.'),
      };
    }
    if (operation !== 'executor.execute') throw new Error('Unsupported executor operation.');
    const grant = run.grants.get(String(b.grant));
    run.grants.delete(String(b.grant));
    if (blocked || !grant || grant.hash !== hash || grant.expires < Date.now())
      throw new Error('Execution grant is invalid or expired.');
    return tool.execute(input, toolContext);
  }
}
