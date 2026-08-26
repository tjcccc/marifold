import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { marifoldHome } from '../workspace/WorkspacePaths';
import type { RunWorkspace } from './RunWorkspace';

export const MAX_RUN_ARTIFACTS = 50;
export const MAX_RUN_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface RunArtifact {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface ResolvedRunArtifact extends RunArtifact {
  path: string;
}

/** List regular output files without following symlinks. The model can write
 * only inside the run capability set, but download resolution independently
 * revalidates containment so an output symlink cannot expose another file. */
export function listRunArtifacts(
  workspace: Pick<RunWorkspace, 'outputDir'>,
): RunArtifact[] {
  return listResolvedArtifacts(workspace.outputDir).map(({ path: _path, ...artifact }) => artifact);
}

export function resolveRunArtifact(runId: string, artifactId: string): ResolvedRunArtifact | undefined {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId) || !/^[a-f0-9]{24}$/.test(artifactId)) return undefined;
  const outputDir = path.join(marifoldHome(), 'runs', runId, 'output');
  return listResolvedArtifacts(outputDir).find(artifact => artifact.id === artifactId);
}

function listResolvedArtifacts(outputDir: string): ResolvedRunArtifact[] {
  let root: string;
  try {
    root = fs.realpathSync(outputDir);
  } catch {
    return [];
  }
  const artifacts: ResolvedRunArtifact[] = [];
  const pending = [root];
  while (pending.length > 0 && artifacts.length < MAX_RUN_ARTIFACTS) {
    const directory = pending.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (artifacts.length >= MAX_RUN_ARTIFACTS) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (!isInside(real, root)) continue;
        const stat = fs.statSync(real);
        if (!stat.isFile() || stat.size > MAX_RUN_ARTIFACT_BYTES) continue;
        const relative = path.relative(root, real).split(path.sep).join('/');
        artifacts.push({
          id: crypto.createHash('sha256').update(relative).digest('hex').slice(0, 24),
          name: relative,
          mediaType: mediaTypeFor(relative),
          size: stat.size,
          path: real,
        });
      } catch {
        // An output may disappear while a process is finishing; omit it.
      }
    }
  }
  return artifacts;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function mediaTypeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc': return 'application/msword';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.ppt': return 'application/vnd.ms-powerpoint';
    case '.pdf': return 'application/pdf';
    case '.epub': return 'application/epub+zip';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.json': return 'application/json';
    case '.zip': return 'application/zip';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}
