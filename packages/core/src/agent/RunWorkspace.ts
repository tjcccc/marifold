import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { marifoldHome } from '../workspace/WorkspacePaths';

export const MAX_RUN_INPUT_BYTES = 16 * 1024 * 1024;
export const RUN_WORKSPACE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RunFileInput {
  name: string;
  mediaType: string;
  /** Base64-encoded file bytes. Service clients may not supply host paths. */
  data: string;
}

export interface StagedRunFile {
  name: string;
  mediaType: string;
  path: string;
  size: number;
}

/**
 * Filesystem capability set for one agent run. `readRoots` and `writeRoots`
 * are consumed by the process sandbox; merely approving a shell call never
 * widens them.
 */
export interface RunWorkspace {
  id: string;
  rootDir: string;
  homeDir: string;
  workDir: string;
  inputDir: string;
  outputDir: string;
  tempDir: string;
  cacheDir: string;
  venvDir: string;
  cwd: string;
  userHome: string;
  /** App-owned inputs, such as the active profile's skills, that tools may
   * inspect but never modify through the process sandbox. */
  readOnlyRoots: string[];
  readRoots: string[];
  writeRoots: string[];
  /** Roots outside the user's home. Shell calls touching this capability set
   * remain escalated and can never become a persistent "always" grant. */
  externalRoots: string[];
  files: StagedRunFile[];
}

export interface CreateRunWorkspaceOptions {
  id: string;
  cwd?: string;
  trustedFolders?: string[];
  /** Narrow app-owned folders exposed read-only to this run. Entries outside
   * the user's home remain approval-gated. */
  readOnlyFolders?: string[];
  files?: RunFileInput[];
  /** Test/embedding overrides. Product runs use ~/.marifold/runs and the real
   * account home. */
  runsDir?: string;
  userHome?: string;
}

export function createRunWorkspace(options: CreateRunWorkspaceOptions): RunWorkspace {
  const id = safeRunId(options.id);
  const runsDir = options.runsDir ?? path.join(marifoldHome(), 'runs');
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  pruneRunWorkspaces(runsDir);

  const rootDir = path.join(runsDir, id);
  const homeDir = path.join(rootDir, 'home');
  const workDir = path.join(rootDir, 'work');
  const inputDir = path.join(rootDir, 'input');
  const outputDir = path.join(rootDir, 'output');
  const tempDir = path.join(rootDir, 'tmp');
  const cacheDir = path.join(rootDir, 'cache');
  const venvDir = path.join(workDir, '.venv');
  for (const dir of [rootDir, homeDir, workDir, inputDir, outputDir, tempDir, cacheDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const userHome = canonicalExistingPath(options.userHome ?? os.homedir());
  const requestedCwd = canonicalExistingPath(options.cwd ?? process.cwd());
  // Never turn a broad/sensitive root into an implicit read-write capability.
  // A service launched from $HOME should work in the run scratch directory,
  // not silently grant the model the whole account.
  const appHome = options.runsDir ? path.dirname(canonicalExistingPath(options.runsDir)) : canonicalExistingPath(marifoldHome());
  const cwd = isUnsafeBroadRoot(requestedCwd, userHome, appHome)
    ? canonicalExistingPath(workDir)
    : requestedCwd;
  const trusted = uniqueExistingDirectories(options.trustedFolders ?? [])
    .filter(folder => !isUnsafeBroadRoot(folder, userHome, appHome));
  const readOnlyRoots = uniqueExistingDirectories(options.readOnlyFolders ?? [])
    .filter(folder => isInside(folder, userHome))
    .filter(folder => !isUnsafeBroadReadRoot(folder, userHome, appHome));
  const runWriteRoots = [homeDir, workDir, outputDir, tempDir, cacheDir].map(canonicalExistingPath);
  const writeRoots = uniquePaths([cwd, ...trusted, ...runWriteRoots]);
  const readRoots = uniquePaths([...writeRoots, canonicalExistingPath(inputDir), ...readOnlyRoots]);
  const externalRoots = writeRoots.filter(root => !isInside(root, userHome));

  const workspace: RunWorkspace = {
    id,
    rootDir: canonicalExistingPath(rootDir),
    homeDir: canonicalExistingPath(homeDir),
    workDir: canonicalExistingPath(workDir),
    inputDir: canonicalExistingPath(inputDir),
    outputDir: canonicalExistingPath(outputDir),
    tempDir: canonicalExistingPath(tempDir),
    cacheDir: canonicalExistingPath(cacheDir),
    venvDir: path.join(canonicalExistingPath(workDir), '.venv'),
    cwd,
    userHome,
    readOnlyRoots,
    readRoots,
    writeRoots,
    externalRoots,
    files: [],
  };
  workspace.files = stageRunFiles(workspace, options.files ?? []);
  return workspace;
}

export function stageRunFiles(workspace: RunWorkspace, files: RunFileInput[]): StagedRunFile[] {
  let total = 0;
  const used = new Set<string>();
  return files.map((file, index) => {
    const bytes = decodeBase64(file.data, `files[${index}].data`);
    total += bytes.length;
    if (total > MAX_RUN_INPUT_BYTES) {
      throw MarifoldError.agentRunInvalid(
        `Run input files exceed ${MAX_RUN_INPUT_BYTES / (1024 * 1024)} MiB.`,
      );
    }
    const name = uniqueFileName(safeFileName(file.name, index), used);
    const target = path.join(workspace.inputDir, name);
    fs.writeFileSync(target, bytes, { mode: 0o400 });
    return {
      name,
      mediaType: file.mediaType || 'application/octet-stream',
      path: target,
      size: bytes.length,
    };
  });
}

export function resolveToolPath(input: string, workspace: RunWorkspace | undefined, cwd: string): string {
  if (input === '~' && workspace) return workspace.homeDir;
  if (input.startsWith('~/') && workspace) return path.join(workspace.homeDir, input.slice(2));
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return path.resolve(cwd, input);
}

export function isInsideAnyRoot(target: string, roots: string[]): boolean {
  const resolved = canonicalPath(target);
  return roots.some(root => isInside(resolved, root));
}

export function isOutsideUserHome(target: string, workspace: RunWorkspace): boolean {
  return !isInside(canonicalPath(target), workspace.userHome);
}

export function isSensitiveHostPath(target: string, workspace: RunWorkspace): boolean {
  const resolved = canonicalPath(target);
  if (isInside(resolved, workspace.rootDir)) return false;
  const sensitive = [
    path.join(workspace.userHome, '.ssh'),
    path.join(workspace.userHome, '.gnupg'),
    path.join(workspace.userHome, '.marifold'),
    path.join(workspace.userHome, 'Library', 'Keychains'),
  ];
  return sensitive.some(root => isInside(resolved, root));
}

export function isProtectedSystemWrite(target: string, workspace: RunWorkspace): boolean {
  const resolved = canonicalPath(target);
  if (isInsideAnyRoot(resolved, workspace.writeRoots)) return false;
  const roots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      (value): value is string => Boolean(value),
    )
    : ['/System', '/usr', '/bin', '/sbin', '/Library', '/Applications', '/opt', '/private/etc', '/private/var/db'];
  return roots.some(root => isInside(resolved, canonicalPath(root)));
}

export function isInside(target: string, root: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function uniqueExistingDirectories(values: string[]): string[] {
  return uniquePaths(values.flatMap(value => {
    const resolved = canonicalExistingPath(value);
    try {
      return fs.statSync(resolved).isDirectory() ? [resolved] : [];
    } catch {
      return [];
    }
  }));
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(canonicalExistingPath))];
}

function isUnsafeBroadRoot(target: string, userHome: string, appHome: string): boolean {
  const resolved = canonicalExistingPath(target);
  return resolved === path.parse(resolved).root
    || resolved === userHome
    || resolved === appHome
    || isInside(appHome, resolved)
    || isInside(resolved, appHome);
}

function isUnsafeBroadReadRoot(target: string, userHome: string, appHome: string): boolean {
  const resolved = canonicalExistingPath(target);
  return resolved === path.parse(resolved).root
    || resolved === userHome
    || resolved === appHome
    || isInside(appHome, resolved);
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw MarifoldError.agentRunInvalid(`Invalid execution id '${value}'.`);
  }
  return value;
}

function safeFileName(value: string, index: number): string {
  const base = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base && base !== '.' && base !== '..' ? base : `attachment-${index + 1}`;
}

function uniqueFileName(value: string, used: Set<string>): string {
  let candidate = value;
  const ext = path.extname(value);
  const stem = value.slice(0, value.length - ext.length);
  let number = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${number}${ext}`;
    number += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function decodeBase64(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw MarifoldError.agentRunInvalid(`${label} must be non-empty base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw MarifoldError.agentRunInvalid(`${label} must be non-empty base64.`);
  return bytes;
}

function pruneRunWorkspaces(runsDir: string): void {
  const cutoff = Date.now() - RUN_WORKSPACE_RETENTION_MS;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(run|task|tool)_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const target = path.join(runsDir, entry.name);
    try {
      if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; inability to prune an old run must not block a
      // new one.
    }
  }
}
