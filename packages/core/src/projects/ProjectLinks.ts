import { matchMention, mentionTokens } from '../agent/Mentions';
import { MarifoldError } from '../errors/MarifoldError';
import type { LinkedProjectAsset, ProjectAsset } from './ProjectAssets';

/**
 * Linked project assets (docs/projects.md#assets): the `@device/path` targets
 * that name them, and where a run finds each one. A link stays on its device
 * and is read there: a run on that device reads it with its own file tools,
 * which may read it without asking; a run elsewhere delegates to that device.
 */

/** A workspace device a link can name. */
export interface LinkDevice {
  id: string;
  name: string;
  host: boolean;
  online: boolean;
  executor: boolean;
}

/** Where a run's tools work, for telling it how to reach each link. */
export interface LinkRun {
  /** The workspace's devices; empty without a workspace. */
  devices: readonly LinkDevice[];
  /** The device the run's tools work on; absent for the host. */
  deviceId?: string;
  /** The run has delegate_device. */
  delegate: boolean;
}

/**
 * The device and path a link target names: `@office/~/notes`,
 * `@"Home Mac"/Volumes/data` (an absolute path), or an untagged `~/notes` or
 * `/srv/data` on the sending device. The host is `deviceId` absent; the
 * store validates the path.
 */
export function parseLinkTarget(target: string, devices: readonly LinkDevice[], senderDeviceId: string | undefined, projectId: string): { deviceId?: string; path: string } {
  const text = target.trim();
  if (!text.startsWith('@')) {
    const sender = senderDeviceId === undefined ? undefined : devices.find(device => device.id === senderDeviceId);
    if (senderDeviceId !== undefined && !sender) { throw MarifoldError.projectInvalid('The sending device is not in this workspace.', projectId); }
    return { ...(sender && !sender.host ? { deviceId: sender.id } : {}), path: text };
  }
  const mention = mentionTokens(text)[0];
  const matched = mention?.at === 0 ? matchMention(mention, devices, device => [device.id, device.name]) : undefined;
  if (!matched || matched.targets.length !== 1) {
    throw MarifoldError.projectInvalid(`${text} names no single workspace device; pick one from the @ menu.`, projectId);
  }
  const rest = text.slice(matched.end);
  if (!rest.startsWith('/')) { throw MarifoldError.projectInvalid('Write a link as @device/~/path, or @device/ and an absolute path.', projectId); }
  const device = matched.targets[0]!;
  return { ...(device.host ? {} : { deviceId: device.id }), path: rest.startsWith('/~') ? rest.slice(1) : rest };
}

/** The links a run on this device reads with its own tools (`deviceId` absent: the host). */
export function linkedPathsOn(assets: readonly ProjectAsset[], deviceId: string | undefined): string[] {
  return assets.flatMap(asset => asset.kind === 'linked' && asset.deviceId === deviceId ? [asset.path] : []);
}

export interface LinkLocation {
  /** `@device/path`, as the user writes it; the bare path without a workspace. */
  label: string;
  /** The device's name; absent when it left the workspace, or there is none. */
  deviceName?: string;
  /** The device can be reached: online with execution enabled (always for the host). */
  available: boolean;
  /** Why it cannot be reached. */
  unavailable?: 'removed' | 'offline' | 'execution-off';
  /** For the model: how this run reads it, or why it cannot. */
  note: string;
}

export function linkLocation(link: LinkedProjectAsset, run: LinkRun): LinkLocation {
  const device = link.deviceId === undefined ? run.devices.find(candidate => candidate.host) : run.devices.find(candidate => candidate.id === link.deviceId);
  const label = device ? `@${/\s/.test(device.name) ? `"${device.name}"` : device.name}/${link.path.replace(/^\//, '')}` : link.path;
  const unavailable = link.deviceId === undefined ? undefined
    : !device ? 'removed' as const : !device.online ? 'offline' as const : !device.executor ? 'execution-off' as const : undefined;
  const base = { label, ...(device ? { deviceName: device.name } : {}), available: unavailable === undefined, ...(unavailable ? { unavailable } : {}) };
  if (link.deviceId === run.deviceId) { return { ...base, note: `on this run's device; read it with your file tools at ${link.path}` }; }
  if (!device) { return { ...base, note: 'its device is no longer in this workspace' }; }
  if (!device.online) { return { ...base, note: `${device.name} is offline` }; }
  if (!device.executor) { return { ...base, note: `${device.name} has not enabled execution` }; }
  return { ...base, note: run.delegate ? `on ${device.name}; delegate_device ${device.name} to read it there` : `on ${device.name}, which this run cannot reach` };
}
