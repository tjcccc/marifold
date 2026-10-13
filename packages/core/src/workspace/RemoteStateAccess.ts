import * as fs from 'fs';
import * as path from 'path';
import type { MarifoldPathsConfig } from '../config/ConfigSchema';

/** What a run requested from another workspace device may do with this
 * device's Marifold state. */
export interface RemoteStateAccess {
  /** Never readable or writable: Marifold home, config (credentials), the
   * sessions database, and everything not listed in `stateReadRoots`. */
  deniedRoots: string[];
  /** Readable with approval for each access, never writable. */
  stateReadRoots: string[];
}

/**
 * Default deny with an explicit readable allowlist, so files added to
 * Marifold home later stay protected. Configured paths may live outside
 * Marifold home, so they are listed explicitly on both sides.
 */
export function remoteStateAccess(home: string, configPath: string, paths: MarifoldPathsConfig): RemoteStateAccess {
  return {
    deniedRoots: [home, configPath, ...sessionsDbFiles(paths.sessionsDb)],
    stateReadRoots: [
      paths.profilesDir,
      paths.tasksDir,
      paths.skillsDir ?? path.join(home, 'skills'),
      paths.appsDir ?? path.join(home, 'apps'),
      paths.schedulesDir ?? path.join(home, 'schedules'),
      path.join(home, 'prompts'),
      path.join(home, 'runs'),
    ],
  };
}

/** The database and its companions (`-wal`, `-shm`, `.leases`, backups). */
function sessionsDbFiles(sessionsDb: string): string[] {
  const directory = path.dirname(sessionsDb);
  const name = path.basename(sessionsDb);
  let siblings: string[] = [];
  try {
    siblings = fs.readdirSync(directory).filter(entry => entry.startsWith(name)).map(entry => path.join(directory, entry));
  } catch {
    // A missing directory has no companions yet.
  }
  return [sessionsDb, ...['-wal', '-shm', '-journal', '.leases'].map(suffix => sessionsDb + suffix), ...siblings];
}

/** True when a request names Marifold's own state folder, which belongs to
 * the workspace host like the profiles and skills it holds. */
export function mentionsMarifoldState(text: string): boolean {
  return /(?:~|\$HOME|\/(?:Users|home)\/[^/\s]+)\/\.marifold(?![\w.-])/i.test(text);
}
