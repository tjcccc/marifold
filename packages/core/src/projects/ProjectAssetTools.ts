import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { mediaTypeFor, resolveWorkspaceArtifact, runArtifactId } from '../agent/RunArtifacts';
import { type AgentTool, capToolOutput, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../agent/ToolRegistry';
import { prepareImageInputs } from '../images/ImageOptimizer';
import { type ArtifactChunk, workspaceArtifactStream } from '../workspace/WorkspaceArtifactTransfer';
import { formatBytes, MAX_ASSET_BYTES, type ProjectAsset, type ProjectAssets } from './ProjectAssets';

/**
 * A project run's asset tools (docs/projects.md#how-the-agent-sees-assets):
 * `list_assets` and `read_asset` over the project's stored assets, and
 * `save_asset`, which stores a file from this run's output folder, or text,
 * for every profile here. Saving changes only marifold's own store and keeps
 * earlier versions, so it needs no approval; a profile whose writes are denied
 * still cannot save.
 */

/** This run's output folder, wherever its tools run. */
export interface RunOutputs {
  /** A file by its `/`-separated path inside the output folder. */
  read(relative: string, ctx: ToolExecutionContext): Promise<{ data: Buffer; mediaType: string }>;
  /** The run's tools work on the host, so read_asset can copy a binary asset into its work folder. */
  local: boolean;
}

export interface ProjectAssetRun {
  assets: ProjectAssets;
  projectId: string;
  /** The answering profile, recorded on what it saves. */
  profile?: string;
  runId?: string;
  outputs: RunOutputs;
}

const MANIFEST_ROWS = 30;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TEXT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const ROUTINE: ToolRiskAssessment = { escalate: false, routine: true };

/** A file the run cannot save, told to the model rather than failing the call. */
class OutputRefusal extends Error {}

/** The run instructions' short asset list: names and descriptions, never content. */
export function projectAssetManifest(assets: ProjectAssets, projectId: string): string {
  const { assets: list, usage } = assets.list(projectId);
  const intro = "Project assets are files this project keeps for every profile and session in it. Read one with read_asset. Save a deliverable the user wants kept, or material later work here needs, with save_asset (a name that exists gets a new version); not drafts or scratch files.";
  if (list.length === 0) { return ['## Project assets', `${intro} There are none yet.`].join('\n'); }
  return [
    '## Project assets',
    `${intro} ${list.length} stored, using ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.limitBytes)}:`,
    ...list.slice(0, MANIFEST_ROWS).map(asset => `- ${assetLine(asset)}`),
    ...(list.length > MANIFEST_ROWS ? [`- … and ${list.length - MANIFEST_ROWS} more; list_assets shows them all.`] : []),
  ].join('\n');
}

export function projectAssetTools(run: ProjectAssetRun): AgentTool[] {
  return [listAssetsTool(run), readAssetTool(run), saveAssetTool(run)];
}

/** Outputs of a run whose tools work on the host, with the containment of downloads. */
export const hostRunOutputs: RunOutputs = {
  local: true,
  read: async (relative, ctx) => {
    const artifact = ctx.workspace ? resolveWorkspaceArtifact(ctx.workspace, runArtifactId(relative)) : undefined;
    if (!artifact) { throw new OutputRefusal(notInOutputs(relative)); }
    if (artifact.size > MAX_ASSET_BYTES) { throw new OutputRefusal(tooLarge(artifact.size)); }
    const fd = fs.openSync(artifact.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return { data: fs.readFileSync(fd), mediaType: artifact.mediaType };
    } finally {
      fs.closeSync(fd);
    }
  },
};

/** Outputs on the run's execution device, read over the workspace bridge
 * like a download (`executor.artifact`, which finds them by id). */
export function deviceRunOutputs(read: (input: { artifactId: string; offset: number; length: number }) => Promise<unknown>): RunOutputs {
  return {
    local: false,
    read: async relative => {
      const artifactId = runArtifactId(relative);
      let size: number;
      try {
        size = (await read({ artifactId, offset: 0, length: 1 }) as ArtifactChunk).size;
      } catch {
        throw new OutputRefusal(notInOutputs(relative));
      }
      if (size > MAX_ASSET_BYTES) { throw new OutputRefusal(tooLarge(size)); }
      const parts: Buffer[] = [];
      for await (const part of workspaceArtifactStream(size, (offset, length) => read({ artifactId, offset, length }) as Promise<ArtifactChunk>)) {
        parts.push(part);
      }
      return { data: Buffer.concat(parts), mediaType: mediaTypeFor(relative) };
    },
  };
}

/** `value` as a `/`-separated path inside the output folder: absolute there,
 * or relative to it. Undefined for anything outside it. */
export function outputRelativePath(value: string, outputDir: string): string | undefined {
  const root = outputDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = value.trim().replace(/\\/g, '/');
  let inside = target;
  if (target.startsWith(`${root}/`)) {
    inside = target.slice(root.length + 1);
  } else if (/^(?:[A-Za-z]:)?\//.test(target) || target.startsWith('~')) {
    return undefined;
  }
  const parts = inside.split('/').filter(part => part !== '' && part !== '.');
  return parts.length > 0 && !parts.includes('..') ? parts.join('/') : undefined;
}

function listAssetsTool(run: ProjectAssetRun): AgentTool {
  return {
    kind: 'read',
    definition: {
      name: 'list_assets',
      description: "List this project's stored assets: name, type, size, latest version, who saved it, and description. Read content with read_asset.",
      parameters: { type: 'object', properties: {} },
    },
    summarizeCall: () => 'list project assets',
    assessRisk: () => ROUTINE,
    execute: async () => {
      const { assets, usage } = run.assets.list(run.projectId);
      if (assets.length === 0) { return { content: 'This project has no stored assets.', summary: 'no assets' }; }
      return {
        content: [`${assets.length} assets, using ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.limitBytes)}:`, ...assets.map(asset => `- ${assetLine(asset)}`)].join('\n'),
        summary: `${assets.length} assets`,
      };
    },
  };
}

function readAssetTool(run: ProjectAssetRun): AgentTool {
  return {
    kind: 'read',
    definition: {
      name: 'read_asset',
      description: [
        "Read one of this project's stored assets by name.",
        'Text returns its content; an image becomes visible to the model; another binary file is copied into this run\'s work folder for your tools when they run on the workspace host.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Asset name from the project asset list.' },
          version: { type: 'integer', description: 'An earlier version; the latest when omitted.' },
        },
        required: ['name'],
      },
    },
    summarizeCall: input => `read asset ${typeof input.name === 'string' ? input.name : '<missing name>'}${typeof input.version === 'number' ? ` v${input.version}` : ''}`,
    assessRisk: () => ROUTINE,
    execute: async (input, ctx) => {
      const name = requireStringInput(input, 'name', 'read_asset');
      const asset = run.assets.find(run.projectId, name);
      if (!asset) { return missing(run, name); }
      const version = input.version === undefined ? undefined : input.version;
      if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
        return { content: 'version must be a positive whole number.', isError: true, summary: 'invalid version' };
      }
      let content: ReturnType<ProjectAssets['content']>;
      try {
        content = run.assets.content(run.projectId, asset.id, version);
      } catch (error) {
        return failed(error, `read ${asset.name}`);
      }
      const label = `${content.name} v${content.version}`;
      const type = content.mediaType.split(';')[0]!.trim();
      const data = fs.readFileSync(content.path);
      if (IMAGE_TYPES.has(type)) {
        const { images } = await prepareImageInputs([{ data: data.toString('base64'), mediaType: type }], { optimize: true });
        return { content: `Asset ${label} (${type}, ${formatBytes(content.size)}) is now visible as image input.`, images, summary: `opened image ${label}` };
      }
      const text = utf8Text(data);
      if (text !== undefined) {
        const copy = text.length > ctx.outputLimit && run.outputs.local && ctx.workspace ? placeInWorkDir(ctx.workspace.workDir, content) : undefined;
        return {
          content: `Asset ${label} (${type}, ${formatBytes(content.size)}):\n${capToolOutput(text, ctx.outputLimit)}${copy ? `\n[The whole file is at ${copy}.]` : ''}`,
          summary: `read ${label}`,
        };
      }
      if (!run.outputs.local || !ctx.workspace) {
        return {
          content: `Asset ${label} is a ${type} file (${formatBytes(content.size)}). Binary assets reach a run's tools only when the run executes on the workspace host; this one executes on another device.`,
          isError: true,
          summary: `${label} is binary`,
        };
      }
      const copy = placeInWorkDir(ctx.workspace.workDir, content);
      return { content: `Asset ${label} is a ${type} file (${formatBytes(content.size)}); a copy for this run's tools is at ${copy}.`, summary: `copied ${label}` };
    },
  };
}

function saveAssetTool(run: ProjectAssetRun): AgentTool {
  return {
    kind: 'write',
    definition: {
      name: 'save_asset',
      description: [
        'Store a file as a project asset, kept for every profile and session in this project. Saving a name that exists adds a version and keeps the earlier ones.',
        "Give path, a file in this run's output folder (absolute, or relative to that folder), or content, text to store under name.",
        'When to use: a deliverable the user wants kept, or material later work in this project needs. When NOT to use: drafts, scratch files, or files outside the output folder (copy them there first).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "A file in this run's output folder." },
          content: { type: 'string', description: 'Text to store instead of a file; needs name.' },
          name: { type: 'string', description: "Asset name; the file's name when omitted. A name that exists gets a new version." },
          description: { type: 'string', description: 'One line on what it is, shown in the asset list.' },
        },
      },
    },
    summarizeCall: input => `save ${[input.name, input.path].find(value => typeof value === 'string') ?? 'text'} to project assets`,
    assessRisk: () => ROUTINE,
    execute: async (input, ctx) => {
      const file = typeof input.path === 'string' && input.path.trim() ? input.path : undefined;
      const text = typeof input.content === 'string' ? input.content : undefined;
      const given = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
      if ((file === undefined) === (text === undefined)) { return { content: 'Give either path or content.', isError: true, summary: 'nothing to save' }; }
      let name: string;
      let data: Buffer;
      let mediaType: string;
      if (file !== undefined) {
        const relative = ctx.workspace ? outputRelativePath(file, ctx.workspace.outputDir) : undefined;
        if (!relative) {
          return { content: `${file} is not in this run's output folder${ctx.workspace ? ` (${ctx.workspace.outputDir})` : ''}. Copy the file there first.`, isError: true, summary: 'outside the output folder' };
        }
        try {
          ({ data, mediaType } = await run.outputs.read(relative, ctx));
        } catch (error) {
          return failed(error, `save ${relative}`);
        }
        name = given ?? path.posix.basename(relative);
        if (mediaType === 'application/octet-stream') { mediaType = TEXT_TYPES[path.extname(name).toLowerCase()] ?? mediaType; }
      } else {
        if (given === undefined) { return { content: 'Saving content needs a name.', isError: true, summary: 'missing name' }; }
        name = given;
        data = Buffer.from(text!, 'utf8');
        mediaType = TEXT_TYPES[path.extname(name).toLowerCase()] ?? 'text/plain; charset=utf-8';
      }
      try {
        const { asset, newVersion } = run.assets.save(run.projectId, {
          name,
          data,
          mediaType,
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(run.profile ? { savedBy: run.profile } : {}),
          ...(run.runId ? { runId: run.runId } : {}),
        });
        return newVersion
          ? { content: `Saved ${asset.name} as version ${asset.version} (${formatBytes(asset.size)}).`, summary: `saved ${asset.name} v${asset.version}` }
          : { content: `${asset.name} v${asset.version} already has this content; no version was added.`, summary: `${asset.name} unchanged` };
      } catch (error) {
        return failed(error, `save ${name}`);
      }
    },
  };
}

function assetLine(asset: ProjectAsset): string {
  return `${asset.name} (${asset.mediaType.split(';')[0]}, ${formatBytes(asset.size)}, v${asset.version}${asset.savedBy ? `, saved by ${asset.savedBy}` : ''})${asset.description ? ` — ${asset.description}` : ''}`;
}

function missing(run: ProjectAssetRun, name: string): ToolExecutionResult {
  const names = run.assets.list(run.projectId).assets.map(asset => asset.name);
  return {
    content: `No asset named '${name}'. ${names.length > 0 ? `Assets: ${names.slice(0, MANIFEST_ROWS).join(', ')}${names.length > MANIFEST_ROWS ? ', …' : ''}.` : 'This project has no stored assets.'}`,
    isError: true,
    summary: `asset ${name} not found`,
  };
}

/** Expected refusals (not found, over the limit, invalid names) go back to
 * the model; anything else fails the call as usual. */
function failed(error: unknown, action: string): ToolExecutionResult {
  if (!(error instanceof MarifoldError) && !(error instanceof OutputRefusal)) { throw error; }
  return { content: error.message, isError: true, summary: `${action} failed` };
}

function utf8Text(data: Buffer): string | undefined {
  if (data.includes(0)) { return undefined; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function placeInWorkDir(workDir: string, content: { path: string; name: string; version: number }): string {
  const target = path.join(workDir, 'assets', `v${content.version}`, content.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(content.path, target);
  return target;
}

function notInOutputs(relative: string): string {
  return `No file at ${relative} in this run's output folder.`;
}

function tooLarge(size: number): string {
  return `An asset is at most ${formatBytes(MAX_ASSET_BYTES)}; this file is ${formatBytes(size)}.`;
}
