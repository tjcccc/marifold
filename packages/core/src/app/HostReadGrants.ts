import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sensitiveHostRoots } from '../agent/RunWorkspace';
import { MarifoldError } from '../errors/MarifoldError';

export type HostReadGrantKind = 'file' | 'folder';

export interface HostReadGrantRequest {
  /** Path as declared: absolute, `~`, `~/…`, or relative to `relativeTo`. */
  declared: string;
  kind: HostReadGrantKind;
  /** Base for relative declarations; relative paths are rejected without it. */
  relativeTo?: string;
  /** A root inside Marifold private state that may still be granted (an App bundle). */
  allowedPrivateRoot?: string;
  /** Error wording: `${label} ${kind} ${noun} '…'`, e.g. "Declared file permission". */
  label: string;
  noun: string;
  source?: string;
}

/** Resolve one static, auto-approved host read grant and refuse anything that
 * would widen it: missing paths, the wrong file type, broad or sensitive
 * roots, and Marifold private state. Shared by SkillApp permissions and
 * Skill-declared reads so both enforce the same boundary. */
export function resolveHostReadGrant(request: HostReadGrantRequest): string {
  const { declared, kind, label, noun, source } = request;
  const userHome = fs.realpathSync(os.homedir());
  const privateAppHome = path.join(userHome, '.marifold');
  const requested = expandHostPath(declared, userHome, request.relativeTo);
  if (!requested) {
    throw MarifoldError.appInvalid(`${label} ${kind} ${noun} '${declared}' must be an absolute or ~/ path.`, source);
  }
  let resolved: string;
  let stat: fs.Stats;
  try {
    resolved = fs.realpathSync(requested);
    stat = fs.statSync(resolved);
  } catch (error) {
    throw MarifoldError.appInvalid(
      `${label} ${kind} ${noun} '${declared}' cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      source,
    );
  }
  if (kind === 'file' && !stat.isFile()) {
    throw MarifoldError.appInvalid(`${label} file ${noun} '${declared}' is not a regular file.`, source);
  }
  if (kind === 'folder' && !stat.isDirectory()) {
    throw MarifoldError.appInvalid(`${label} folder ${noun} '${declared}' is not a directory.`, source);
  }
  if (kind === 'folder' && isBroadReadRoot(resolved, userHome, privateAppHome)) {
    throw MarifoldError.appInvalid(`${label} folder ${noun} '${declared}' is too broad or sensitive.`, source);
  }
  const allowedPrivateRoot = request.allowedPrivateRoot ? fs.realpathSync(request.allowedPrivateRoot) : undefined;
  if (isInside(resolved, privateAppHome) && !(allowedPrivateRoot && isInside(resolved, allowedPrivateRoot))) {
    throw MarifoldError.appInvalid(`${label} ${noun} '${declared}' cannot expose Marifold private state.`, source);
  }
  // These reads are auto-approved, so they never reach account secrets that
  // ordinary runs must approve one access at a time.
  const sensitive = sensitiveHostRoots(userHome).filter(root => root !== privateAppHome);
  if (sensitive.some(root => isInside(resolved, root) || isInside(root, resolved))) {
    throw MarifoldError.appInvalid(`${label} ${noun} '${declared}' would expose sensitive account data.`, source);
  }
  return resolved;
}

function expandHostPath(declared: string, userHome: string, relativeTo?: string): string | undefined {
  if (declared === '~') { return userHome; }
  if (declared.startsWith('~/')) { return path.join(userHome, declared.slice(2)); }
  if (path.isAbsolute(declared)) { return declared; }
  return relativeTo ? path.join(relativeTo, declared) : undefined;
}

function isBroadReadRoot(target: string, userHome: string, privateAppHome: string): boolean {
  return target === path.parse(target).root
    || target === userHome
    || target === privateAppHome
    || isInside(privateAppHome, target);
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
