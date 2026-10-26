import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  canonicalPath,
  isDeniedRunPath,
  isExactPath,
  isInside,
  isInsideAnyRoot,
  isOutsideUserHome,
  isProtectedSystemWrite,
  isReadOnlyStatePath,
  isSensitiveHostPath,
  type RunWorkspace,
  sensitiveHostRoots,
  startupConfigPaths,
} from './RunWorkspace';
import type { ToolRiskAssessment } from './ToolRegistry';

/*
 * File permission policy. Workspace devices all belong to one user, so the
 * same rules apply on every device:
 * - Reads follow the read mode, anywhere; credential stores and other
 *   sensitive roots ask, and the user may allow one root persistently.
 * - Ordinary writes inside home are routine: no prompt unless writes are
 *   denied. Overwrites and deletions move the previous version to the Trash.
 * - Writes outside home, to sensitive roots, or to login/startup
 *   configuration ask for each call.
 */

const BLOCKED_STATE = 'This path contains device-local or other-workspace state.';

export function isStartupConfigPath(target: string, workspace: RunWorkspace): boolean {
  return isInsideAnyRoot(target, startupConfigPaths(workspace.userHome));
}

/** The home-relative sensitive root containing `target` (e.g. `~/.ssh`). */
export function sensitiveReadGrant(target: string, workspace: RunWorkspace): string | undefined {
  if (isInside(target, workspace.rootDir)) { return undefined; }
  const root = sensitiveHostRoots(workspace.userHome).find(candidate => isInside(target, candidate));
  return root === undefined ? undefined : `~/${path.relative(workspace.userHome, root).split(path.sep).join('/')}`;
}

/** Read policy for a canonical target. */
export function assessFileRead(target: string, workspace: RunWorkspace): ToolRiskAssessment {
  if (isDeniedRunPath(target, workspace)) { return { escalate: false, blocked: true, persistable: false, reason: BLOCKED_STATE }; }
  if (isInsideAnyRoot(target, workspace.readRoots) || isExactPath(target, workspace.readOnlyFiles)) { return { escalate: false }; }
  if (isReadOnlyStatePath(target, workspace)) {
    return { escalate: true, persistable: false, reason: `reading Marifold state at ${target} is approved one access at a time`, targetPath: target };
  }
  const grant = sensitiveReadGrant(target, workspace);
  // Marifold's own state (keys, policy, sessions) is approved one read at a time.
  if (grant === '~/.marifold') {
    return { escalate: true, persistable: false, reason: `${target} is Marifold's own state`, targetPath: target };
  }
  if (grant) {
    return { escalate: true, reason: `${target} may contain credentials or private data`, targetPath: target, sensitiveGrant: grant };
  }
  return { escalate: false };
}

/** Write policy for a canonical target: the destination of a write, copy,
 * new folder, or move. */
export function assessFileWrite(target: string, workspace: RunWorkspace): ToolRiskAssessment {
  if (isDeniedRunPath(target, workspace)) { return { escalate: false, blocked: true, persistable: false, reason: BLOCKED_STATE }; }
  if (isReadOnlyStatePath(target, workspace)) {
    return { escalate: false, blocked: true, persistable: false, reason: 'Marifold state on this device is read-only for requests from another workspace device.' };
  }
  if (isProtectedSystemWrite(target, workspace)) {
    return { escalate: false, blocked: true, persistable: false, reason: `system path ${target} is read-only for agent runs`, targetPath: target };
  }
  // The run's own folders belong to this run.
  if (isInside(target, workspace.rootDir)) { return { escalate: false, routine: true }; }
  const reason = isSensitiveHostPath(target, workspace) ? `${target} may contain credentials or private data`
    : isStartupConfigPath(target, workspace) ? `${target} is login or startup configuration`
      : isOutsideUserHome(target, workspace) ? `${target} is outside the user's home directory`
        : canonicalPath(target) === canonicalPath(workspace.userHome) ? 'the target is the home directory itself'
          : undefined;
  return reason ? { escalate: true, persistable: false, reason, targetPath: target } : { escalate: false, routine: true };
}

/** Policy for moving or trashing `target` (the entry itself, not a link's
 * destination). Home, or a folder above it, is never removed; a folder that
 * contains sensitive or startup data asks. */
export function assessFileRemoval(target: string, workspace: RunWorkspace): ToolRiskAssessment {
  const write = assessFileWrite(target, workspace);
  if (write.blocked) { return write; }
  if (isInside(workspace.userHome, target) || isInside(workspace.rootDir, target)) {
    return { escalate: false, blocked: true, persistable: false, reason: `${target} contains the home directory or this run's folders` };
  }
  if (write.escalate) { return write; }
  const contained = [...sensitiveHostRoots(workspace.userHome), ...startupConfigPaths(workspace.userHome), ...(workspace.deniedRoots ?? [])]
    .filter(root => fs.existsSync(root))
    .some(root => isInside(root, target));
  return contained
    ? { escalate: true, persistable: false, reason: `${target} contains credentials, private data, or startup configuration`, targetPath: target }
    : write;
}

/** Real location of an entry without following a final symlink: the link
 * itself is what a move or trash acts on. */
export function entryPath(target: string): string {
  return path.join(canonicalPath(path.dirname(target)), path.basename(target));
}

/** Combine the assessments of a two-path operation (copy, move). The
 * destination's run grant/target path is kept only when it alone escalates. */
export function combineRisks(source: ToolRiskAssessment, destination: ToolRiskAssessment): ToolRiskAssessment {
  for (const risk of [source, destination]) {
    if (risk.blocked) { return risk; }
  }
  if (!source.escalate && !destination.escalate) {
    if (source.trusted && destination.trusted) { return { escalate: false, trusted: true }; }
    return (source.routine || source.trusted) && (destination.routine || destination.trusted) ? { escalate: false, routine: true } : { escalate: false };
  }
  const reason = [source, destination].filter(risk => risk.escalate && risk.reason).map(risk => risk.reason).join('; ');
  const persistable = source.persistable !== false && destination.persistable !== false && !(source.escalate && destination.escalate);
  const single = source.escalate ? source : destination;
  return {
    escalate: true,
    persistable,
    reason,
    ...(single.targetPath ? { targetPath: single.targetPath } : {}),
    ...(single.runGrantFolder && persistable ? { runGrantFolder: single.runGrantFolder } : {}),
    ...(single.sensitiveGrant && persistable ? { sensitiveGrant: single.sensitiveGrant } : {}),
  };
}

/**
 * Move `target` to the user's Trash and return a short description of where
 * it went. Never deletes permanently: an item that cannot be trashed (another
 * volume, unsupported platform) is left in place and an error is thrown.
 */
export async function moveToTrash(target: string, userHome: string): Promise<string> {
  fs.lstatSync(target); // a missing item fails here, not inside the platform tool
  if (process.platform === 'darwin') {
    // The system tool keeps Finder's "Put Back" metadata. A test or embedding
    // home override uses that home's own .Trash instead.
    if (canonicalPath(userHome) === canonicalPath(os.homedir()) && fs.existsSync('/usr/bin/trash')) {
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/trash', [target], error => (error ? reject(new Error(`trash failed: ${error.message}`)) : resolve()));
      });
      if (entryExists(target)) { throw new Error(`${target} is still in place after moving it to the Trash`); }
      return 'the Trash';
    }
    const trash = path.join(userHome, '.Trash');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    const destination = uniqueEntry(trash, path.basename(target));
    renameWithinVolume(target, destination);
    return destination;
  }
  if (process.platform === 'linux') {
    const dataHome = canonicalPath(userHome) === canonicalPath(os.homedir()) && process.env.XDG_DATA_HOME
      ? process.env.XDG_DATA_HOME
      : path.join(userHome, '.local', 'share');
    const files = path.join(dataHome, 'Trash', 'files');
    const info = path.join(dataHome, 'Trash', 'info');
    fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    fs.mkdirSync(info, { recursive: true, mode: 0o700 });
    const destination = uniqueEntry(files, path.basename(target), name => fs.existsSync(path.join(info, `${name}.trashinfo`)));
    const infoFile = path.join(info, `${path.basename(destination)}.trashinfo`);
    // XDG trash spec: the info file is written first, exclusively.
    fs.writeFileSync(infoFile, `[Trash Info]\nPath=${encodeURI(target)}\nDeletionDate=${localTimestamp(new Date(), 'T', ':')}\n`, { flag: 'wx', mode: 0o600 });
    try {
      renameWithinVolume(target, destination);
    } catch (error) {
      fs.rmSync(infoFile, { force: true });
      throw error;
    }
    return destination;
  }
  throw new Error(`moving to the Trash is not supported on ${process.platform}`);
}

/** Before replacing an existing regular file, put a copy of its current
 * content in the Trash so the overwrite can be undone. Returns where it went,
 * or undefined when there was nothing to keep. Throws (leaving the file
 * untouched) when no backup could be made. */
export async function trashPreviousVersion(target: string, userHome: string): Promise<string | undefined> {
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { return undefined; }
  if (!stat.isFile()) { return undefined; }
  const extension = path.extname(target);
  const stem = path.basename(target, extension);
  const copy = uniqueEntry(path.dirname(target), `${stem} (before ${localTimestamp(new Date(), ' ', '.')})${extension}`);
  fs.copyFileSync(target, copy, fs.constants.COPYFILE_EXCL);
  try {
    return await moveToTrash(copy, userHome);
  } catch (error) {
    fs.rmSync(copy, { force: true });
    throw new Error(`could not keep the previous version in the Trash (${error instanceof Error ? error.message : String(error)}); nothing was changed`);
  }
}

function renameWithinVolume(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(`${source} is on another volume than the Trash; it was left in place`);
    }
    throw error;
  }
}

function uniqueEntry(directory: string, name: string, taken: (name: string) => boolean = () => false): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let number = 2; entryExists(path.join(directory, candidate)) || taken(candidate); number += 1) {
    candidate = `${stem} ${number}${extension}`;
  }
  return path.join(directory, candidate);
}

/** True for any directory entry, including a dangling symlink. Only a
 * missing entry counts as absent; an unreadable one is treated as taken. */
export function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function localTimestamp(date: Date, separator: string, timeSeparator: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${separator}`
    + [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(timeSeparator);
}
