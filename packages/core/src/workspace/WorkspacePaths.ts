import * as os from 'os';
import * as path from 'path';

export function marifoldHome(): string {
  return path.join(os.homedir(), '.marifold');
}

export function defaultConfigPath(): string {
  return path.join(marifoldHome(), 'config.toml');
}

export function defaultProfilesDir(): string {
  return path.join(marifoldHome(), 'profiles');
}

export function defaultSessionsDb(): string {
  return path.join(marifoldHome(), 'sessions.db');
}

export function defaultTasksDir(): string {
  return path.join(marifoldHome(), 'tasks');
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveUserPath(input: string): string {
  return path.resolve(expandHome(input));
}
