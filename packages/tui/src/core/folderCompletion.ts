import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Commands whose argument is a folder on this device. */
const FOLDER_COMMAND = /^\/(?:trust-folder|add-dir)\s+(\S*)$/;
const LIMIT = 50;

export interface FolderCompletion {
  /** Offset in the input where the typed path starts (replaced on accept). */
  start: number;
  /** The path typed so far. */
  partial: string;
  /** Matching folders, each ending in `/` so Tab can keep descending. */
  items: Array<{ name: string; hint?: string }>;
}

/** Folder suggestions for `/trust-folder <path>` and `/add-dir <path>`, read
 * from this device. Hidden folders appear only once a `.` is typed. */
export function folderCompletion(beforeCursor: string, cwd = process.cwd(), home = os.homedir()): FolderCompletion | undefined {
  const match = FOLDER_COMMAND.exec(beforeCursor);
  if (!match) { return undefined; }
  const partial = match[1] ?? '';
  const start = beforeCursor.length - partial.length;
  const slash = partial.lastIndexOf('/');
  // `~` alone completes to `~/`; otherwise list the folder before the last slash.
  const typedDir = partial === '~' ? '~/' : slash >= 0 ? partial.slice(0, slash + 1) : '';
  const prefix = partial === '~' ? '' : partial.slice(slash + 1);
  const expanded = typedDir.startsWith('~/') ? path.join(home, typedDir.slice(2)) : typedDir;
  const directory = path.resolve(cwd, expanded || '.');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { start, partial, items: [] };
  }
  const items = entries
    .filter(entry => entry.name.startsWith(prefix) && (prefix.startsWith('.') || !entry.name.startsWith('.')))
    .filter(entry => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(directory, entry.name))))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, LIMIT)
    .map(name => ({ name: `${typedDir}${name}/` }));
  return { start, partial, items };
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
