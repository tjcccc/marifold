import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ImageInput } from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { listRunArtifacts } from './RunArtifacts';
import { marifoldHome } from '../workspace/WorkspacePaths';
import type { EarlierRunImage } from './EarlierImages';

export const MAX_RUN_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_RUN_INSPECTION_TEXT_BYTES = 256 * 1024;
export const RUN_WORKSPACE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RunFileInput {
  name: string;
  mediaType: string;
  /** Base64-encoded file bytes. Service clients may not supply host paths. */
  data: string;
  /** Optional bounded text already extracted by the submitting client (for example
   * from DOCX/XLSX/PPTX in the browser). The original bytes remain authoritative. */
  inspectionText?: string;
}

export interface StagedRunFile {
  id: string;
  name: string;
  mediaType: string;
  path: string;
  size: number;
  inspectionText?: string;
}

/** One upload addressable by an agent through inspect_attachment. Local
 * uploads are copied into the run input directory; remote image references
 * remain URLs and are never fetched by the staging boundary. */
export interface StagedRunAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  path?: string;
  image?: ImageInput;
  inspectionText?: string;
}

/**
 * Filesystem capability set for one agent run. `readRoots` and `writeRoots`
 * are consumed by the process sandbox; merely approving a shell call never
 * widens them.
 */
export interface RunWorkspace {
  id: string;
  rootDir: string;
  /** Disposable app/runtime state directory. User-facing `~` paths resolve
   * against `userHome`, not this directory. */
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
  /** Exact host files explicitly granted read-only. Their parent directories
   * are not capabilities and must not become listable. */
  readOnlyFiles: string[];
  deniedRoots?: string[];
  /** Parts of `deniedRoots` this run may still read with approval for each
   * access, and never write. */
  stateReadRoots?: string[];
  readRoots: string[];
  writeRoots: string[];
  /** Trusted folders that became write roots (cwd and run dirs excluded). */
  trustedRoots?: string[];
  /** The profile trusts `~`: sandboxed scripts may create and modify files
   * anywhere in home, but never delete or rename them, and never touch
   * sensitive roots or login/startup configuration. */
  homeScriptWrites?: boolean;
  /** Roots outside the user's home. Shell calls touching this capability set
   * remain escalated and can never become a persistent "always" grant. */
  externalRoots: string[];
  files: StagedRunFile[];
  attachments: StagedRunAttachment[];
  /** Images from earlier session turns, staged only when inspected. */
  earlierImages?: EarlierRunImage[];
}

export interface CreateRunWorkspaceOptions {
  deniedRoots?: string[];
  stateReadRoots?: string[];
  id: string;
  cwd?: string;
  /** Stored trusted folder entries: `~` (home script writes), `~/…`
   * (resolved against this device's home), or absolute paths. */
  trustedFolders?: string[];
  /** Narrow app-owned folders exposed read-only to this run. Entries outside
   * the user's home remain approval-gated. */
  readOnlyFolders?: string[];
  /** Explicit internal capability for statically declared resources. Ordinary
   * profile/global read roots remain confined to the user home. */
  allowExternalReadOnlyFolders?: boolean;
  /** Narrow exact-file capabilities. Unlike readOnlyFolders, these never widen
   * access to siblings in the containing directory. */
  readOnlyFiles?: string[];
  /** A project's linked files and folders on this device (`~/…` or absolute):
   * read-only, also outside home. Checked here, on the device that enforces
   * them: broad roots, app state, denied roots, and anything holding or inside
   * a sensitive or startup root are dropped, so reads there still ask. */
  linkedFolders?: string[];
  files?: RunFileInput[];
  /** Prepared image inputs to stage alongside ordinary files for lazy,
   * attachment-scoped inspection during an agent run. */
  images?: ImageInput[];
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
  // `~/…` comes from another device (or a TUI) and means this device's home;
  // a folder missing here falls back to the run's own work folder.
  const cwdInput = options.cwd === '~' ? userHome : options.cwd?.startsWith('~/') ? path.join(userHome, options.cwd.slice(2)) : options.cwd;
  const requestedCwd = canonicalExistingPath(cwdInput !== undefined && !isDirectory(cwdInput) ? workDir : cwdInput ?? process.cwd());
  // Never turn a broad/sensitive root into an implicit read-write capability.
  // A service launched from $HOME should work in the run scratch directory,
  // not silently grant the model the whole account.
  const appHome = options.runsDir ? path.dirname(canonicalExistingPath(options.runsDir)) : canonicalExistingPath(marifoldHome());
  const cwd = isUnsafeBroadRoot(requestedCwd, userHome, appHome) || coversProtectedRoot(requestedCwd, userHome)
    ? canonicalExistingPath(workDir)
    : requestedCwd;
  const entries = resolveTrustedFolders(options.trustedFolders ?? [], userHome);
  const trusted = uniqueExistingDirectories(entries.folders)
    .filter(folder => !isUnsafeBroadRoot(folder, userHome, appHome) && !coversProtectedRoot(folder, userHome));
  const readOnlyRoots = uniqueExistingDirectories(options.readOnlyFolders ?? [])
    .filter(folder => options.allowExternalReadOnlyFolders || isInside(folder, userHome))
    .filter(folder => !isUnsafeBroadReadRoot(folder, userHome, appHome));
  const linked = linkedReadPaths(options.linkedFolders ?? [], userHome, appHome, options.deniedRoots ?? []);
  readOnlyRoots.push(...linked.folders.filter(folder => !readOnlyRoots.includes(folder)));
  const readOnlyFiles = uniqueExistingFiles([...(options.readOnlyFiles ?? []), ...linked.files]);
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
    readOnlyFiles,
    deniedRoots: uniquePaths(options.deniedRoots ?? []),
    stateReadRoots: uniquePaths(options.stateReadRoots ?? []),
    readRoots,
    writeRoots,
    trustedRoots: trusted,
    ...(entries.homeScriptWrites ? { homeScriptWrites: true } : {}),
    externalRoots,
    files: [],
    attachments: [],
  };
  workspace.files = stageRunFiles(workspace, options.files ?? []);
  workspace.attachments.push(...workspace.files);
  stageRunImages(workspace, options.images ?? []);
  return workspace;
}

export function stageRunFiles(workspace: RunWorkspace, files: RunFileInput[]): StagedRunFile[] {
  let total = workspace.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const used = new Set(workspace.attachments.map(attachment => attachment.name.toLowerCase()));
  return files.map((file, index) => {
    const bytes = decodeBase64(file.data, `files[${index}].data`);
    total += bytes.length;
    if (total > MAX_RUN_INPUT_BYTES) {
      throw MarifoldError.agentRunInvalid(
        `Run attachments exceed ${MAX_RUN_INPUT_BYTES / (1024 * 1024)} MiB.`,
      );
    }
    if (file.inspectionText && Buffer.byteLength(file.inspectionText, 'utf8') > MAX_RUN_INSPECTION_TEXT_BYTES) {
      throw MarifoldError.agentRunInvalid(
        `files[${index}].inspectionText exceeds ${MAX_RUN_INSPECTION_TEXT_BYTES / 1024} KiB.`,
      );
    }
    const name = uniqueFileName(safeFileName(file.name, index), used);
    const target = path.join(workspace.inputDir, name);
    fs.writeFileSync(target, bytes, { mode: 0o400 });
    return {
      id: `attachment-${workspace.attachments.length + index + 1}`,
      name,
      mediaType: file.mediaType || 'application/octet-stream',
      path: target,
      size: bytes.length,
      ...(file.inspectionText ? { inspectionText: file.inspectionText } : {}),
    };
  });
}

/** Stage local/embedded images into the same read-only attachment area used by
 * files. This lets an agent inspect an image only when needed instead of
 * sending it on every stateless model iteration. */
export function stageRunImages(workspace: RunWorkspace, images: ImageInput[]): StagedRunAttachment[] {
  const used = new Set(workspace.attachments.map(attachment => attachment.name.toLowerCase()));
  let total = workspace.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const staged = images.map((image, index): StagedRunAttachment => {
    const id = `attachment-${workspace.attachments.length + index + 1}`;
    const mediaType = image.mediaType || 'image/jpeg';
    const extension = imageExtension(mediaType);
    const name = uniqueFileName(`image-${index + 1}.${extension}`, used);
    if (image.url) {
      return { id, name, mediaType, size: 0, image: { url: image.url, mediaType } };
    }

    let bytes: Buffer;
    try {
      bytes = image.path ? fs.readFileSync(image.path) : decodeBase64(image.data ?? '', `images[${index}].data`);
    } catch (error) {
      if (error instanceof MarifoldError) { throw error; }
      throw MarifoldError.agentRunInvalid(
        `Could not stage image #${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    total += bytes.length;
    if (total > MAX_RUN_INPUT_BYTES) {
      throw MarifoldError.agentRunInvalid(
        `Run attachments exceed ${MAX_RUN_INPUT_BYTES / (1024 * 1024)} MiB.`,
      );
    }
    const target = path.join(workspace.inputDir, name);
    fs.writeFileSync(target, bytes, { mode: 0o400 });
    return {
      id,
      name,
      mediaType,
      path: target,
      size: bytes.length,
      image: { path: target, mediaType },
    };
  });
  workspace.attachments.push(...staged);
  return staged;
}

export function resolveToolPath(input: string, workspace: RunWorkspace | undefined, cwd: string): string {
  if (input === '~' && workspace) { return workspace.userHome; }
  if (input.startsWith('~/') && workspace) { return path.join(workspace.userHome, input.slice(2)); }
  if (input === '~') { return os.homedir(); }
  if (input.startsWith('~/')) { return path.join(os.homedir(), input.slice(2)); }
  return path.resolve(cwd, input);
}

export function isInsideAnyRoot(target: string, roots: string[]): boolean {
  const resolved = canonicalPath(target);
  return roots.some(root => isInside(resolved, root));
}

export function isExactPath(target: string, candidates: string[]): boolean {
  const resolved = canonicalPath(target);
  return candidates.some(candidate => resolved === canonicalPath(candidate));
}

export function isOutsideUserHome(target: string, workspace: RunWorkspace): boolean {
  return !isInside(canonicalPath(target), workspace.userHome);
}

export function isDeniedRunPath(target: string, workspace: RunWorkspace): boolean {
  return !isInsideAnyRoot(target, [workspace.rootDir])
    && isInsideAnyRoot(target, workspace.deniedRoots ?? [])
    && !isInsideAnyRoot(target, workspace.stateReadRoots ?? []);
}

/** Marifold state this run may read but never write. */
export function isReadOnlyStatePath(target: string, workspace: RunWorkspace): boolean {
  return !isInsideAnyRoot(target, [workspace.rootDir]) && isInsideAnyRoot(target, workspace.stateReadRoots ?? []);
}

/** Home-relative account data that may hold credentials or private data:
 * writes ask for each call, reads ask unless the profile allows that root
 * (`sensitive_read_grants`), and SkillApps cannot declare it. */
export const SENSITIVE_HOME_ENTRIES: readonly string[] = [
  '.ssh', '.gnupg', '.marifold', 'Library/Keychains', '.password-store',
  // Common credential stores.
  '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.config/gh', '.config/gcloud', '.config/hub',
  // Browser profiles: cookies, saved passwords, and history.
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Safari',
  'Library/Cookies', '.config/google-chrome', '.config/chromium', '.mozilla',
];

export function sensitiveHostRoots(userHome: string): string[] {
  return SENSITIVE_HOME_ENTRIES.map(entry => path.join(userHome, ...entry.split('/')));
}

/** Login and startup configuration under home. Changing it alters what runs
 * automatically, so file tools ask for each write and the sandbox never
 * writes there unless a run root explicitly re-opens it. */
export function startupConfigPaths(userHome: string): string[] {
  return [
    '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
    '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile',
    '.login', '.cshrc', '.tcshrc', '.xprofile', '.xinitrc', '.xsessionrc',
    '.config/fish', '.config/autostart', '.config/systemd', '.config/environment.d',
    'Library/LaunchAgents',
  ].map(name => path.join(userHome, ...name.split('/')));
}

/** The trusted folder entry that grants sandboxed scripts home writes. */
export const HOME_TRUSTED_FOLDER = '~';

/** The stored form of a trusted folder: `~` for home itself, `~/…` inside
 * home (so one entry applies to every device's home), absolute otherwise. */
export function trustedFolderEntry(folder: string, userHome = os.homedir()): string {
  const trimmed = folder.trim();
  const expanded = trimmed === '~' ? userHome : trimmed.startsWith('~/') ? path.join(userHome, trimmed.slice(2)) : trimmed;
  const resolved = canonicalExistingPath(expanded);
  const home = canonicalExistingPath(userHome);
  if (resolved === home) { return HOME_TRUSTED_FOLDER; }
  if (!isInside(resolved, home)) { return resolved; }
  return `~/${path.relative(home, resolved).split(path.sep).join('/')}`;
}

/** Stored entries expanded against one device's home. `~` never becomes a
 * folder capability; it only turns on {@link RunWorkspace.homeScriptWrites}. */
export function resolveTrustedFolders(entries: string[], userHome: string): { folders: string[]; homeScriptWrites: boolean } {
  let homeScriptWrites = false;
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry === HOME_TRUSTED_FOLDER || entry === '~/') { homeScriptWrites = true; }
    else if (entry.startsWith('~/')) { folders.push(path.join(userHome, entry.slice(2))); }
    else if (path.isAbsolute(entry)) { folders.push(entry); }
  }
  return { folders: uniquePaths(folders), homeScriptWrites };
}

/** Entries that may travel to another workspace device: home-relative only.
 * Absolute in-home paths are converted with this device's home; folders
 * outside home stay on this device. */
export function portableTrustedFolders(entries: string[], userHome = os.homedir()): string[] {
  return [...new Set(entries.map(entry => trustedFolderEntry(entry, userHome)).filter(entry => entry.startsWith('~')))];
}

/** True when a folder is inside, or contains, a credential store, browser
 * profile, Marifold state or startup configuration. Trusting it would reopen
 * what the sandbox otherwise denies, so it never becomes a trusted folder. */
export function coversProtectedRoot(folder: string, userHome: string): boolean {
  const resolved = canonicalExistingPath(folder);
  const home = canonicalExistingPath(userHome);
  return [...sensitiveHostRoots(home), ...startupConfigPaths(home)].map(canonicalExistingPath)
    .some(root => isInside(resolved, root) || isInside(root, resolved));
}

/** Validate home-relative entries another workspace device requested for a
 * run here. Rejects anything that leaves this device's home (`..`, links),
 * or covers sensitive roots, Marifold state, or startup configuration. */
export function acceptedRemoteTrustedFolders(value: unknown, userHome: string): string[] {
  if (!Array.isArray(value)) { return []; }
  const home = canonicalExistingPath(userHome);
  const accepted: string[] = [];
  for (const entry of value.slice(0, 64)) {
    if (typeof entry !== 'string') { continue; }
    if (entry === HOME_TRUSTED_FOLDER) { accepted.push(entry); continue; }
    if (!entry.startsWith('~/') || entry.includes('\0') || entry.split('/').some(part => part === '..')) { continue; }
    const resolved = canonicalExistingPath(path.join(home, entry.slice(2)));
    if (resolved === home || !isInside(resolved, home)) { continue; }
    if (coversProtectedRoot(resolved, home)) { continue; }
    accepted.push(`~/${path.relative(home, resolved).split(path.sep).join('/')}`);
  }
  return [...new Set(accepted)];
}

/** The folder a run-scoped grant (or a trust) for this target would cover:
 * the folder itself, or a file's parent folder, inside the user's home but
 * never home itself, a sensitive or denied root, or a folder containing one. */
export function runGrantFolder(target: string, workspace: RunWorkspace): string | undefined {
  // The run's own folders belong to this run anyway.
  if (isInside(target, workspace.rootDir)) { return canonicalPath(workspace.rootDir); }
  const resolved = canonicalPath(target);
  const folder = isDirectory(resolved) ? resolved : path.dirname(resolved);
  const home = canonicalPath(workspace.userHome);
  if (folder === home || !isInside(folder, home)) { return undefined; }
  const protectedRoots = [...sensitiveHostRoots(workspace.userHome), ...(workspace.deniedRoots ?? []), ...(workspace.stateReadRoots ?? [])];
  if (protectedRoots.some(root => isInside(folder, root) || isInside(root, folder))) { return undefined; }
  return folder;
}

export function isSensitiveHostPath(target: string, workspace: RunWorkspace): boolean {
  const resolved = canonicalPath(target);
  if (isInside(resolved, workspace.rootDir)) { return false; }
  return [...sensitiveHostRoots(workspace.userHome), ...(workspace.stateReadRoots ?? [])].some(root => isInside(resolved, root));
}

export function isProtectedSystemWrite(target: string, workspace: RunWorkspace): boolean {
  const resolved = canonicalPath(target);
  if (isInsideAnyRoot(resolved, workspace.writeRoots)) { return false; }
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

/** Above the kernel symlink limits (macOS 32, Linux 40): any chain this gives
 * up on also fails with ELOOP when a tool opens it. */
const MAX_SYMLINK_HOPS = 64;

/** The real location a path reaches: symlinks are followed (dangling ones
 * included) and missing trailing components are kept. Tools assess and report
 * this path so approvals and trusted folders never apply to a link's location
 * instead of its destination. */
export function canonicalPath(value: string, hops = 0): string {
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    // `existsSync` follows links, so a dangling symlink looks missing. Writing
    // through it creates the link target, so resolve where the link points.
    const target = symlinkTarget(cursor);
    if (target !== undefined && hops < MAX_SYMLINK_HOPS) {
      return canonicalPath(path.join(target, ...suffix), hops + 1);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) { return resolved; }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function symlinkTarget(value: string): string | undefined {
  try {
    if (!fs.lstatSync(value).isSymbolicLink()) { return undefined; }
    return path.resolve(path.dirname(value), fs.readlinkSync(value));
  } catch {
    return undefined;
  }
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

function uniqueExistingFiles(values: string[]): string[] {
  return uniquePaths(values.flatMap(value => {
    const resolved = canonicalExistingPath(value);
    try {
      return fs.statSync(resolved).isFile() ? [resolved] : [];
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

function linkedReadPaths(entries: string[], userHome: string, appHome: string, deniedRoots: string[]): { folders: string[]; files: string[] } {
  const folders: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.includes('\0')) { continue; }
    const local = entry === '~' ? userHome : entry.startsWith('~/') ? path.join(userHome, entry.slice(2)) : entry;
    if (!path.isAbsolute(local)) { continue; }
    const resolved = canonicalExistingPath(local);
    if (isUnsafeBroadRoot(resolved, userHome, appHome) || coversProtectedRoot(resolved, userHome)
      || deniedRoots.some(root => isInside(resolved, root) || isInside(root, resolved))) { continue; }
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) { folders.push(resolved); } else if (stat.isFile()) { files.push(resolved); }
    } catch {
      // Missing on this device: the link is unavailable here.
    }
  }
  return { folders, files };
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

function imageExtension(mediaType: string): string {
  if (mediaType === 'image/png') { return 'png'; }
  if (mediaType === 'image/webp') { return 'webp'; }
  if (mediaType === 'image/gif') { return 'gif'; }
  return 'jpg';
}

function decodeBase64(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw MarifoldError.agentRunInvalid(`${label} must be non-empty base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) { throw MarifoldError.agentRunInvalid(`${label} must be non-empty base64.`); }
  return bytes;
}

function pruneRunWorkspaces(runsDir: string): void {
  const cutoff = Date.now() - RUN_WORKSPACE_RETENTION_MS;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(run|task|tool)_[A-Za-z0-9_-]+$/.test(entry.name)) { continue; }
    const target = path.join(runsDir, entry.name);
    try {
      if (fs.statSync(target).mtimeMs >= cutoff) { continue; }
      if (listRunArtifacts({ outputDir: path.join(target, 'output') }).length > 0) {
        // Downloads outlive disposable inputs, environments, and execution state.
        for (const child of fs.readdirSync(target)) {
          if (child !== 'output') { fs.rmSync(path.join(target, child), { recursive: true, force: true }); }
        }
      } else {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best-effort; inability to prune an old run must not block a
      // new one.
    }
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
