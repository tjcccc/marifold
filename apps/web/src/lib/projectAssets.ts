import type { ListedProjectAsset, ProjectAssetUsage, RunArtifact, StoredProjectAsset } from '../api/types';

/** Uploads are base64 JSON inside the service's 25 MB request limit. */
export const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

/** One output of a run in this session, the run it came from first. */
export interface SessionOutput {
  runId: string;
  profile: string;
  artifact: RunArtifact;
}

/** Storage sizes as people say them: "34 MB", "2.2 MB", "18 KB". */
export function formatStorage(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/** The Assets card's summary: "7 · 34 MB of 100 MB". */
export function assetsSummary(count: number, usage: ProjectAssetUsage): string {
  return `${count} · ${formatStorage(usage.usedBytes)} of ${formatStorage(usage.limitBytes)}`;
}

/** At 90% the summary turns to the warning color and explains what fits. */
export function nearLimit(usage: ProjectAssetUsage): boolean {
  return usage.usedBytes >= usage.limitBytes * 0.9;
}

export function usedFraction(usage: ProjectAssetUsage): number {
  return usage.limitBytes > 0 ? Math.min(1, usage.usedBytes / usage.limitBytes) : 1;
}

/** Why a file cannot be uploaded at all, before reading it. The project's
 * limit is the service's to judge: equal content is stored once. */
export function uploadProblem(file: { name: string; size: number }): string | undefined {
  if (file.size === 0) { return `${file.name} is empty.`; }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatStorage(file.size)}; an upload is at most ${formatStorage(MAX_UPLOAD_BYTES)}. Link it on its device instead.`;
  }
  return undefined;
}

/** "v2 · 18 KB · dev_test", or "uploaded" when no profile saved it. */
export function storedMeta(asset: StoredProjectAsset): string {
  return `v${asset.version} · ${formatStorage(asset.size)} · ${asset.savedBy ?? 'uploaded'}`;
}

const UNAVAILABLE = { offline: 'offline', 'execution-off': 'execution off', removed: 'device removed' } as const;

/** Where a link lives, written as its target: `@office/~/sprites`. */
export function linkLabel(asset: Extract<ListedProjectAsset, { kind: 'linked' }>): string {
  const device = asset.deviceName ?? asset.deviceId;
  return device ? `@${device}/${asset.path.replace(/^\//, '')}` : asset.path;
}

/** Why profiles cannot read a link now ("offline"), if they cannot. */
export function linkUnavailable(asset: Extract<ListedProjectAsset, { kind: 'linked' }>): string | undefined {
  return asset.unavailable ? UNAVAILABLE[asset.unavailable] : undefined;
}

/** The target `POST …/links` reads: a bare path on the sending device, else
 * `@device-id/~/…` or `@device-id/` and an absolute path without its slash. */
export function linkTarget(deviceId: string | undefined, path: string): string {
  const trimmed = path.trim();
  return deviceId ? `@${deviceId}/${trimmed.replace(/^\//, '')}` : trimmed;
}

/** A link's default name: the last part of its path. */
export function defaultLinkName(path: string): string {
  const parts = path.trim().replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1] ?? '';
  return last === '~' ? '' : last;
}

function basename(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** Whether an output already became a stored asset: an asset by the output's
 * name that one of its runs saved. A guess, since the agent may also have
 * saved it under another name, or renamed it since. */
export function outputInAssets(output: SessionOutput, assets: readonly ListedProjectAsset[]): boolean {
  const runIds = new Set([output.runId, ...(output.artifact.source ? [output.artifact.source.runId] : [])]);
  const name = basename(output.artifact.name);
  return assets.some(asset => asset.kind === 'stored' && asset.name === name && (asset.runIds ?? []).some(id => runIds.has(id)));
}

/** Outputs of a session's top-level runs, newest run first. A delegated run's
 * outputs already appear on the run that started it. */
export function sessionOutputs(runs: ReadonlyArray<{ id: string; profile: string; parentRunId?: string; artifacts?: RunArtifact[] }>): SessionOutput[] {
  return runs
    .filter(run => !run.parentRunId)
    .flatMap(run => (run.artifacts ?? []).map(artifact => ({ runId: run.id, profile: run.profile, artifact })));
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type LimitUnit = 'MB' | 'GB';

/** Core's DEFAULT_ASSET_LIMIT_BYTES, which a `null` limit returns to. */
export const DEFAULT_LIMIT_BYTES = 100 * MB;

/** A limit as the settings row shows it: whole GB when it is, else MB. */
export function limitParts(bytes: number): { value: string; unit: LimitUnit } {
  if (bytes >= GB && bytes % GB === 0) { return { value: String(bytes / GB), unit: 'GB' }; }
  return { value: String(Math.round((bytes / MB) * 100) / 100), unit: 'MB' };
}

/** Bytes for a typed limit, or undefined when it is not a positive number. */
export function limitBytes(value: string, unit: LimitUnit): number | undefined {
  const amount = Number(value.trim());
  if (!value.trim() || !Number.isFinite(amount) || amount <= 0) { return undefined; }
  return Math.round(amount * (unit === 'GB' ? GB : MB));
}
