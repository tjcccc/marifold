import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Replace a file's contents in one step. Readers in other processes (a
 * service re-reading config before each provider request) see the old or the
 * new file, never a truncated one, and a crash mid-write leaves the old file.
 * A symlinked target keeps its link: the real file is replaced in its own
 * directory, with its existing permissions. */
export function writeFileAtomic(file: string, content: string): void {
  let target = path.resolve(file);
  try { target = fs.realpathSync(target); } catch { /* New file. */ }
  let mode: number | undefined;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* New file. */ }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) { fs.chmodSync(temp, mode); }
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
