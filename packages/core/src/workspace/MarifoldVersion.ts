import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** The package manifest is shipped with both source and built installations. */
export const MARIFOLD_VERSION: string = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
).version;

export function workspaceVersionError(remote: unknown, peer = 'host'): string | undefined {
  return remote === MARIFOLD_VERSION
    ? undefined
    : `Workspace version mismatch: this device runs ${MARIFOLD_VERSION}, ${peer} runs ${typeof remote === 'string' ? remote : 'an unknown version'}. Update both devices to the same version before connecting.`;
}
