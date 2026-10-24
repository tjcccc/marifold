import * as fs from 'node:fs';
import * as path from 'node:path';
import { marifoldHome } from '../WorkspacePaths';

// Written by `marifold workspace bridge deploy cloudflare`; read when hosting a workspace on that bridge.
export const BRIDGE_TOKEN_FILE = 'registration-token';
export const BRIDGE_DEPLOYMENT_FILE = 'deployment.json';

export function cloudflareBridgeDirectory(): string {
  return path.join(marifoldHome(), 'bridge', 'cloudflare');
}
/** The origin of the bridge this device deployed, if any. */
export function savedBridgeUrl(): string | undefined {
  try {
    const file = path.join(cloudflareBridgeDirectory(), BRIDGE_DEPLOYMENT_FILE);
    const deployment = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: unknown };
    return typeof deployment.url === 'string' ? new URL(deployment.url).origin : undefined;
  } catch {
    return undefined;
  }
}
/** The registration token this device saved when it deployed `bridgeUrl`, if any. */
export function savedBridgeToken(bridgeUrl: string): string | undefined {
  try {
    if (savedBridgeUrl() !== new URL(bridgeUrl).origin) { return undefined; }
    return fs.readFileSync(path.join(cloudflareBridgeDirectory(), BRIDGE_TOKEN_FILE), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
