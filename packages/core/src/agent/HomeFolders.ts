import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { isInside, sensitiveHostRoots, trustedFolderEntry } from './RunWorkspace';

/** One level of the home folder tree, for the trusted-folder picker. */
export interface HomeFolderListing {
  /** Home-relative path of the listed folder: `~` or `~/…`. */
  path: string;
  /** The folder above, unless this is home. */
  parent?: string;
  folders: Array<{ name: string; path: string }>;
  /** True when the listing was cut at {@link MAX_FOLDERS}. */
  truncated: boolean;
}

const MAX_FOLDERS = 500;

/**
 * Subfolders of a folder inside home. Names only, never files; hidden
 * folders, credential stores, browser profiles and Marifold state are left
 * out, and paths that resolve outside home (through `..` or links) are
 * refused.
 */
export function listHomeFolders(input: string, userHome = os.homedir()): HomeFolderListing {
  const home = fs.realpathSync(userHome);
  const entry = trustedFolderEntry(input.trim() || '~', home);
  if (!entry.startsWith('~')) { throw MarifoldError.configInvalid('Only folders inside home can be browsed.'); }
  const folder = entry === '~' ? home : path.join(home, entry.slice(2));
  const hidden = sensitiveHostRoots(home);
  if (hidden.some(root => isInside(folder, root))) { throw MarifoldError.configInvalid('This folder is private.'); }
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    throw MarifoldError.configInvalid(`Cannot open ${entry}.`);
  }
  const folders: HomeFolderListing['folders'] = [];
  for (const dirent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.name.startsWith('.')) { continue; }
    const child = path.join(folder, dirent.name);
    let real: string;
    try {
      real = fs.realpathSync(child);
      if (!fs.statSync(real).isDirectory()) { continue; }
    } catch {
      continue;
    }
    if (!isInside(real, home) || hidden.some(root => isInside(real, root) || isInside(child, root))) { continue; }
    folders.push({ name: dirent.name, path: trustedFolderEntry(child, home) });
    if (folders.length >= MAX_FOLDERS) { break; }
  }
  const parent = entry === '~' ? undefined : trustedFolderEntry(path.dirname(folder), home);
  return { path: entry, ...(parent ? { parent } : {}), folders, truncated: folders.length >= MAX_FOLDERS };
}
