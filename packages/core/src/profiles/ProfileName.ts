import { MarifoldError } from '../errors/MarifoldError';

/** Rule for names given to new or renamed profiles. A profile name is also its
 * account name on the agent computer, so it must be a valid Linux username. */
export const NEW_PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Accounts and groups that already exist in the agent computer's Ubuntu image. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy',
  'www-data', 'backup', 'list', 'irc', 'nobody', 'nogroup', 'ubuntu', 'agent', 'sudo', 'users',
  'staff', 'adm', 'marifold', 'marifold-agents',
]);

export const NEW_PROFILE_NAME_HINT = 'Use lowercase letters, numbers, underscores, or hyphens, starting with a letter (at most 32 characters).';

/** Why `name` cannot be used for a new profile, or undefined when it can. */
export function newProfileNameProblem(name: string): string | undefined {
  if (!NEW_PROFILE_NAME.test(name)) { return `Invalid profile name '${name}'. ${NEW_PROFILE_NAME_HINT}`; }
  if (RESERVED_PROFILE_NAMES.has(name)) { return `'${name}' is reserved for a system account; choose another profile name.`; }
  return undefined;
}

export function assertNewProfileName(name: string): void {
  const problem = newProfileNameProblem(name);
  if (problem) { throw MarifoldError.profileInvalid(problem, name); }
}
