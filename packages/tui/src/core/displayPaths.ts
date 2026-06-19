import * as os from 'os';
import * as path from 'path';

/** Compress an absolute path under $HOME to a leading `~` for display, the
 * inverse of core's `expandHome`. Returns the input unchanged when it is not
 * inside the home directory. */
export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}
