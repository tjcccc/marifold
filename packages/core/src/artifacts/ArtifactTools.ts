import * as fs from 'fs';
import * as path from 'path';
import { artifactMentions } from '../agent/Mentions';
import { MAX_RUN_ARTIFACTS, runArtifactId } from '../agent/RunArtifacts';
import { type AgentTool, capToolOutput, requireStringInput, type ToolExecutionContext, type ToolExecutionResult, type ToolRiskAssessment } from '../agent/ToolRegistry';
import { MarifoldError } from '../errors/MarifoldError';
import { OutputRefusal, outputRelativePath, type RunOutputs } from '../projects/ProjectAssetTools';
import { ARTIFACT_ID, type ArtifactBundleFile, bundleEntry } from './ArtifactBundle';
import { ARTIFACT_LIMITS, type ArtifactDetail, type ArtifactLibrary, type ArtifactSummary } from './ArtifactLibrary';
import { formatBytes } from '../projects/ProjectAssets';

/**
 * A run's artifact tools (docs/artifacts.md#agent-tools): `save_artifact`
 * stores a bundle from this run's output folder in the library, `list_artifacts`
 * and `read_artifact` reach the artifacts this run may use. A run sees its
 * session's artifacts, its project's, and those the user mentioned with
 * `@[title]` / `@[id]` or picked; saving changes only marifold's own store and
 * keeps earlier versions, so it needs no approval.
 */

export interface ArtifactRun {
  library: ArtifactLibrary;
  profile?: string;
  sessionId?: string;
  runId?: string;
  projectId?: string;
  /** Artifacts the user referenced this turn; saves during the run join them. */
  referenced: Set<string>;
  outputs: RunOutputs;
  /** The user's message asks for an artifact, so the run may create one;
   * otherwise it may only save new versions of artifacts in scope. */
  mayCreate?: boolean;
}

/** Whether the user's message asks for an artifact: it says so, or names or
 * picks one. Profiles never create artifacts on their own initiative. */
export function asksForArtifact(text: string, picked: readonly string[] = []): boolean {
  return picked.length > 0 || /artifact/i.test(text) || artifactMentions(text).length > 0;
}

/** The user's `@[…]` references and picker chips, resolved against the library. */
export interface ArtifactReferences {
  ids: string[];
  /** Titles naming several artifacts, with their candidates. */
  ambiguous: Array<{ ref: string; candidates: ArtifactSummary[] }>;
  unknown: string[];
}

const ROUTINE: ToolRiskAssessment = { escalate: false, routine: true };
const MANIFEST_ROWS = 20;
const MAX_REFERENCES = 20;

export function resolveArtifactReferences(library: ArtifactLibrary, text: string, picked: readonly string[] = []): ArtifactReferences {
  const ids = new Set<string>();
  const ambiguous: ArtifactReferences['ambiguous'] = [];
  const unknown: string[] = [];
  for (const id of picked) {
    if (library.list({ ids: [id], limit: 1 }).length > 0) { ids.add(id); } else { unknown.push(id); }
  }
  for (const { ref } of artifactMentions(text).slice(0, MAX_REFERENCES)) {
    if (ARTIFACT_ID.test(ref) && library.list({ ids: [ref], limit: 1 }).length > 0) {
      ids.add(ref);
      continue;
    }
    const matches = library.list({ query: ref, limit: 50 }).filter(item => item.title.toLowerCase() === ref.toLowerCase());
    // A chip writes its title into the text and sends the picked id.
    if (matches.some(item => picked.includes(item.id))) { continue; }
    if (matches.length === 1) { ids.add(matches[0]!.id); } else if (matches.length > 1) { ambiguous.push({ ref, candidates: matches }); } else { unknown.push(ref); }
  }
  return { ids: [...ids], ambiguous, unknown };
}

/** The artifacts this run may use, newest first. */
export function artifactsInScope(run: ArtifactRun): ArtifactSummary[] {
  const found = new Map<string, ArtifactSummary>();
  const add = (items: ArtifactSummary[]) => { for (const item of items) { found.set(item.id, item); } };
  if (run.referenced.size > 0) { add(run.library.list({ ids: [...run.referenced], limit: 500 })); }
  if (run.sessionId) { add(run.library.list({ sessionId: run.sessionId, limit: 500 })); }
  if (run.projectId) { add(run.library.list({ projectId: run.projectId, limit: 500 })); }
  return [...found.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** The run instructions' artifact section: when to save one, how to build it,
 * and the artifacts this run may use. */
export function artifactInstructions(run: ArtifactRun, references: ArtifactReferences): string {
  const usable = artifactsInScope(run);
  const lines = [
    '## Artifacts',
    'The artifact library keeps pages and documents the user chose to read again. Save into it only when the user asks for that (to save or keep something as an artifact, or to change an artifact they name); asking you to make a page, report, or file is not asking to save it. Otherwise deliver files in your output folder as usual: the user can save one with Save as artifact.',
    ...(run.mayCreate ? [] : ['This message does not ask for an artifact, so do not create one; save_artifact here only saves a new version of an artifact listed below.']),
    'To save, write the bundle into a folder in your output folder and call save_artifact; to change an artifact, save it again with its artifact_id (earlier versions are kept). A bundle is an HTML page or a Markdown document with its files beside it (styles, scripts, images, data). Artifacts are shown sandboxed with no network: put everything in the bundle, link files relatively, and use no CDN or remote images.',
  ];
  if (usable.length > 0) {
    lines.push('Artifacts this conversation can use (read them with read_artifact):');
    lines.push(...usable.slice(0, MANIFEST_ROWS).map(item => `- ${artifactLine(item, run.library)}`));
    if (usable.length > MANIFEST_ROWS) { lines.push(`- … and ${usable.length - MANIFEST_ROWS} more; list_artifacts shows them all.`); }
  }
  for (const { ref, candidates } of references.ambiguous) {
    lines.push(`The user's @[${ref}] names ${candidates.length} artifacts; ask which one they mean, giving the ids: ${candidates.slice(0, 5).map(item => `${item.id} (${item.updatedAt.slice(0, 10)})`).join(', ')}.`);
  }
  if (references.unknown.length > 0) {
    lines.push(`No artifact matches ${references.unknown.map(ref => `@[${ref}]`).join(', ')}; say so rather than guessing.`);
  }
  return lines.join('\n');
}

export function artifactTools(run: ArtifactRun): AgentTool[] {
  return [listArtifactsTool(run), readArtifactTool(run), saveArtifactTool(run)];
}

function listArtifactsTool(run: ArtifactRun): AgentTool {
  return {
    kind: 'read',
    definition: {
      name: 'list_artifacts',
      description: 'List the library artifacts this conversation can use: its own, its project\'s, and those the user mentioned, with id, kind, version, folder, and description.',
      parameters: { type: 'object', properties: {} },
    },
    summarizeCall: () => 'list artifacts',
    assessRisk: () => ROUTINE,
    execute: async () => {
      const usable = artifactsInScope(run);
      if (usable.length === 0) { return { content: 'No artifacts are available to this conversation yet.', summary: 'no artifacts' }; }
      return { content: usable.map(item => `- ${artifactLine(item, run.library)}`).join('\n'), summary: `${usable.length} artifacts` };
    },
  };
}

function readArtifactTool(run: ArtifactRun): AgentTool {
  return {
    kind: 'read',
    definition: {
      name: 'read_artifact',
      description: 'Read a library artifact this conversation can use: its file list and its entry file, or another text file of it by path.',
      parameters: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'The artifact id.' },
          path: { type: 'string', description: 'A file in the artifact; its entry file when omitted.' },
          version: { type: 'integer', description: 'An earlier version; the current one when omitted.' },
        },
        required: ['artifact_id'],
      },
    },
    summarizeCall: input => `read artifact ${typeof input.artifact_id === 'string' ? input.artifact_id : '<missing id>'}${typeof input.path === 'string' ? ` ${input.path}` : ''}`,
    assessRisk: () => ROUTINE,
    execute: async (input, ctx) => {
      const artifact = usableArtifact(run, requireStringInput(input, 'artifact_id', 'read_artifact'));
      if (!artifact) { return unavailable(input.artifact_id); }
      const version = input.version === undefined ? artifact.currentVersion : input.version;
      if (typeof version !== 'number' || !artifact.versions.some(entry => entry.version === version)) {
        return { content: `${artifact.title} has versions ${artifact.versions.map(entry => entry.version).join(', ')}.`, isError: true, summary: 'unknown version' };
      }
      const entry = artifact.versions.find(item => item.version === version)!.entry;
      const wanted = typeof input.path === 'string' && input.path.trim() ? input.path : entry;
      const file = run.library.file(artifact.id, version, wanted);
      if (!file) { return { content: `${artifact.title} v${version} has no file ${wanted}.`, isError: true, summary: 'file not found' }; }
      const header = `${artifact.title} [${artifact.id}] v${version} (${artifact.kind}, entry ${entry})`;
      const files = version === artifact.currentVersion ? artifact.files.map(item => item.path) : [];
      const text = utf8Text(file.absolutePath);
      return {
        content: [
          header,
          ...(files.length > 1 ? [`Files: ${files.join(', ')}`] : []),
          text === undefined ? `${file.path} is a ${file.mediaType} file of ${file.size} bytes.` : `${file.path}:\n${capToolOutput(text, ctx.outputLimit)}`,
        ].join('\n'),
        summary: `read ${artifact.title} v${version}`,
      };
    },
  };
}

function saveArtifactTool(run: ArtifactRun): AgentTool {
  return {
    kind: 'write',
    definition: {
      name: 'save_artifact',
      description: [
        "Save a page or document from this run's output folder to the user's artifact library. Only when the user asks to save or keep it as an artifact, or to change an artifact; never just because you made a page.",
        'Give dir, the bundle\'s folder in the output folder, and files, its files relative to dir (all files under dir when omitted).',
        'The entry is index.html or index.md, the only file, or entry. Give artifact_id to save a new version of an artifact this conversation can use.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title shown in the library; required for a new artifact. A new version keeps the current title.' },
          dir: { type: 'string', description: "The bundle folder inside this run's output folder; the output folder itself when omitted." },
          files: { type: 'array', items: { type: 'string' }, description: 'Bundle files relative to dir.' },
          entry: { type: 'string', description: 'The .html or .md file shown first, relative to dir.' },
          folder: { type: 'string', description: 'Library folder for a new artifact; created when missing. Unfiled when omitted.' },
          description: { type: 'string', description: 'One line on what it is.' },
          note: { type: 'string', description: 'What changed, for a new version.' },
          artifact_id: { type: 'string', description: 'Save as a new version of this artifact.' },
        },
      },
    },
    summarizeCall: input => `save artifact ${[input.title, input.artifact_id].find(value => typeof value === 'string') ?? '<untitled>'}`,
    assessRisk: () => ROUTINE,
    execute: async (input, ctx) => {
      const string = (key: string) => typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : undefined;
      const existing = string('artifact_id');
      if (existing && !usableArtifact(run, existing)) { return unavailable(existing); }
      const title = string('title');
      if (!existing && !run.mayCreate) {
        return { content: 'Not saved: the user did not ask for an artifact. Leave the files in your output folder and do not say they were saved; the user can save one with Save as artifact.', isError: true, summary: 'not requested' };
      }
      if (!existing && !title) { return { content: 'A new artifact needs a title.', isError: true, summary: 'missing title' }; }
      let files: ArtifactBundleFile[];
      let prefix: string;
      try {
        ({ files, prefix } = await bundleFromOutputs(run, input, ctx));
      } catch (error) {
        return failed(error, 'save artifact');
      }
      try {
        const entry = string('entry');
        const origin = { ...(run.profile ? { profile: run.profile } : {}), ...(run.runId ? { runId: run.runId } : {}) };
        // A new version keeps the title and folder the user may have changed.
        const saved = existing
          ? run.library.addVersion(existing, { files, ...(entry ? { entry } : {}), ...(string('note') ? { note: string('note') } : {}), ...origin })
          : run.library.create({
            title: title!,
            files,
            ...(entry ? { entry } : {}),
            ...(string('description') ? { description: string('description') } : {}),
            ...(string('note') ? { note: string('note') } : {}),
            ...(string('folder') ? { folderId: run.library.folderNamed(string('folder')!).id } : {}),
            ...origin,
            // Its entry's output, so that row offers to open it rather than save a copy.
            sourceOutput: runArtifactId(`${prefix}${bundleEntry(files, entry).entry}`),
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
            ...(run.projectId ? { projectId: run.projectId } : {}),
          });
        run.referenced.add(saved.id);
        ctx.emitEvent?.({ type: 'artifact_saved', artifact: { id: saved.id, title: saved.title, kind: saved.kind, version: saved.currentVersion } });
        return {
          content: `Saved "${saved.title}" [${saved.id}] as version ${saved.currentVersion} (${saved.kind}, ${saved.files.length} file${saved.files.length === 1 ? '' : 's'}, entry ${saved.entry}). The user can open it in the Artifacts view.`,
          summary: `saved artifact ${saved.title} v${saved.currentVersion}`,
        };
      } catch (error) {
        return failed(error, 'save artifact');
      }
    },
  };
}

/** The bundle's files from the output folder, by their paths inside `dir`,
 * within the library's per-version limits before anything large is read. */
async function bundleFromOutputs(run: ArtifactRun, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ files: ArtifactBundleFile[]; prefix: string }> {
  if (!ctx.workspace) { throw new OutputRefusal('This run has no output folder to save from.'); }
  const outputDir = ctx.workspace.outputDir;
  const dirInput = typeof input.dir === 'string' && input.dir.trim() ? input.dir : undefined;
  const dir = dirInput === undefined ? '' : outputRelativePath(dirInput, outputDir);
  if (dir === undefined) { throw new OutputRefusal(`${dirInput} is not in this run's output folder (${outputDir}). Write the bundle there first.`); }
  const prefix = dir ? `${dir}/` : '';
  const limits = { ...ARTIFACT_LIMITS };
  let names: string[];
  if (Array.isArray(input.files) && input.files.length > 0) {
    if (input.files.length > limits.versionFiles) { throw new OutputRefusal(`An artifact version holds at most ${limits.versionFiles} files.`); }
    names = input.files.map(file => {
      if (typeof file !== 'string') { throw new OutputRefusal('files must be paths relative to dir.'); }
      const inside = outputRelativePath(file, dir ? `${outputDir.replace(/[\\/]+$/, '')}/${dir}` : outputDir);
      if (!inside) { throw new OutputRefusal(`${file} is not inside ${dir || 'the output folder'}.`); }
      return inside;
    });
  } else {
    names = run.outputs.local ? hostBundleFiles(outputDir, dir, limits.versionFiles) : await deviceBundleFiles(run.outputs, prefix);
    if (names.length === 0) { throw new OutputRefusal(`${dir || 'The output folder'} has no files to save.`); }
  }
  const files: ArtifactBundleFile[] = [];
  let total = 0;
  for (const name of names) {
    const data = run.outputs.local ? readHostOutput(outputDir, `${prefix}${name}`, limits.versionBytes - total) : (await run.outputs.read(`${prefix}${name}`, ctx)).data;
    total += data.length;
    if (total > limits.versionBytes) { throw new OutputRefusal(`An artifact version is at most ${formatBytes(limits.versionBytes)}; these files are larger.`); }
    files.push({ path: name, data });
  }
  return { files, prefix };
}

/** Regular files under `dir` (paths relative to it), skipping symlinks and
 * hidden names such as .DS_Store; refused past `max` files. */
function hostBundleFiles(outputDir: string, dir: string, max: number): string[] {
  const root = containedReal(outputDir, dir);
  if (!root) { throw new OutputRefusal(`${dir} is not a folder in this run's output folder.`); }
  const found: string[] = [];
  const walk = (folder: string, relative: string, depth: number) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) { continue; }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && depth < 8) { walk(path.join(folder, entry.name), name, depth + 1); }
      if (!entry.isFile()) { continue; }
      found.push(name);
      if (found.length > max) { throw new OutputRefusal(`An artifact version holds at most ${max} files; ${dir || 'the output folder'} has more.`); }
    }
  };
  walk(root, '', 1);
  return found;
}

/** Files under `prefix` in another device's output listing, hidden names
 * skipped; refused when the listing reached its cap, rather than saved incomplete. */
async function deviceBundleFiles(outputs: RunOutputs, prefix: string): Promise<string[]> {
  const listed = await outputs.list?.() ?? [];
  if (listed.length >= MAX_RUN_ARTIFACTS) { throw new OutputRefusal(`This run's output folder has ${MAX_RUN_ARTIFACTS} or more files on its device, so list the bundle's files in files.`); }
  return listed.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length))
    .filter(name => !name.split('/').some(part => part.startsWith('.')));
}

/** One output file on the host, contained in the output folder and never
 * through a symlink, refused when larger than `budget`. */
function readHostOutput(outputDir: string, relative: string, budget: number): Buffer {
  const real = containedReal(outputDir, relative);
  const stat = real ? fs.lstatSync(real) : undefined;
  if (!real || !stat?.isFile()) { throw new OutputRefusal(`No file at ${relative} in this run's output folder.`); }
  if (stat.size > budget) { throw new OutputRefusal(`An artifact version is at most ${formatBytes(ARTIFACT_LIMITS.versionBytes)}; ${relative} does not fit.`); }
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `relative` resolved inside `outputDir`, undefined when it is missing, a
 * symlink, or resolves outside. */
function containedReal(outputDir: string, relative: string): string | undefined {
  try {
    const root = fs.realpathSync(outputDir);
    const target = path.join(root, ...relative.split('/').filter(Boolean));
    if (fs.lstatSync(target).isSymbolicLink()) { return undefined; }
    const real = fs.realpathSync(target);
    const inside = path.relative(root, real);
    return inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside) ? undefined : real;
  } catch {
    return undefined;
  }
}

function usableArtifact(run: ArtifactRun, id: string): ArtifactDetail | undefined {
  if (!ARTIFACT_ID.test(id) || !artifactsInScope(run).some(item => item.id === id)) { return undefined; }
  return run.library.get(id);
}

function artifactLine(item: ArtifactSummary, library: ArtifactLibrary): string {
  const folder = item.folderId ? library.folders().find(entry => entry.id === item.folderId)?.name : undefined;
  return `[${item.id}] ${item.title} (${item.kind}, v${item.currentVersion}${folder ? `, folder ${folder}` : ''}${item.createdBy ? `, by ${item.createdBy}` : ''}, ${item.updatedAt.slice(0, 10)})${item.description ? ` — ${item.description}` : ''}`;
}

function unavailable(id: unknown): ToolExecutionResult {
  return { content: `No artifact ${typeof id === 'string' ? id : ''} is available to this conversation; list_artifacts shows the ones that are.`, isError: true, summary: 'artifact unavailable' };
}

/** Expected refusals go back to the model; anything else fails the call. */
function failed(error: unknown, action: string): ToolExecutionResult {
  if (!(error instanceof MarifoldError) && !(error instanceof OutputRefusal)) { throw error; }
  return { content: error.message, isError: true, summary: `${action} failed` };
}

function utf8Text(file: string): string | undefined {
  const data = fs.readFileSync(file);
  if (data.includes(0)) { return undefined; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}
