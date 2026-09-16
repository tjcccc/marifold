import { MarifoldError } from '../errors/MarifoldError';

export type ClientInterface = 'terminal' | 'web' | 'desktop' | 'mobile';
export interface ClientEnvironment {
  interface?: ClientInterface;
  timezone?: string;
}
export interface RuntimeEnvironment extends ClientEnvironment {
  /** Relative to the workspace host; supplied by the runtime, not public JSON. */
  request?: 'local' | 'remote';
}

/** Client values are presentation hints, never device-routing authority. */
export function parseClientEnvironment(value: unknown): ClientEnvironment {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw MarifoldError.configInvalid('environment must be an object.');
  const input = value as Record<string, unknown>;
  const result: ClientEnvironment = {};
  if (input.interface !== undefined) {
    if (typeof input.interface !== 'string' || !['terminal', 'web', 'desktop', 'mobile'].includes(input.interface)) throw MarifoldError.configInvalid('Invalid environment interface.');
    result.interface = input.interface as ClientInterface;
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || input.timezone.length > 100) throw MarifoldError.configInvalid('Invalid environment timezone.');
    try { result.timezone = new Intl.DateTimeFormat('en', { timeZone: input.timezone }).resolvedOptions().timeZone; }
    catch { throw MarifoldError.configInvalid('Invalid environment timezone.'); }
  }
  return result;
}

/** Rebuilt for each user turn and kept outside both prompt text and history. */
export function environmentContext(environment: RuntimeEnvironment = {}, now = new Date()): string {
  const client = parseClientEnvironment(environment);
  const timezone = client.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const offset = fields.timeZoneName === 'GMT' ? '+00:00' : fields.timeZoneName.replace('GMT', '');
  return [
    '<environment>',
    `time: ${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}${offset}`,
    `timezone: ${timezone}`,
    ...(client.interface ? [`interface: ${client.interface}`] : []),
    `request: ${environment.request === 'remote' ? 'remote' : 'local'}`,
    '</environment>',
  ].join('\n');
}

export function artifactPresentation(environment?: RuntimeEnvironment): string {
  if (environment?.interface === 'terminal')
    return 'For generated files and images, report their absolute saved paths on the execution device. Terminal output has no Download controls or inline image previews. Never claim a remote path is on the requesting device.';
  if (environment?.interface)
    return 'Generated files and image previews are attached below the answer by the client. Mention filenames naturally; do not invent download URLs or claim the browser has saved a file.';
  return 'Mention generated filenames naturally; do not assume the client has Download controls or image previews.';
}
