import { NEW_PROFILE_NAME, NEW_PROFILE_NAME_HINT, RESERVED_PROFILE_NAMES } from '../profiles/ProfileName';

/** A profile's account on the agent computer. The UID is stable, so files in
 * the /home volume keep their owner when the computer is rebuilt. */
export interface ComputerAccount {
  uid: number;
  access: boolean;
  createdAt: number;
}

/** An account still to be deleted, kept until the computer is reachable. */
export interface PendingRemoval {
  uid: number;
  /** The Linux account name. */
  name: string;
}

export const AGENTS_GROUP = 'marifold-agents';
/** The default profile is the agent itself: its account is created with the
 * computer, is named "marifold", and always has access. */
export const DEFAULT_PROFILE = 'default';
export const DEFAULT_ACCOUNT = 'marifold';

/** The Linux account a profile works in. */
export function accountName(profile: string): string {
  return profile === DEFAULT_PROFILE ? DEFAULT_ACCOUNT : profile;
}

export const FIRST_ACCOUNT_UID = 2000;

/** Why a profile cannot have an account, or undefined when it can. */
export function accountNameProblem(profile: string): string | undefined {
  if (profile === DEFAULT_PROFILE) { return undefined; }
  if (!NEW_PROFILE_NAME.test(profile) || RESERVED_PROFILE_NAMES.has(profile)) {
    return `The profile name "${profile}" cannot be an account name on the agent computer. Rename the profile first (marifold profile rename ${profile} <new-name>). ${NEW_PROFILE_NAME_HINT}`;
  }
  return undefined;
}

export function nextAccountUid(accounts: Record<string, ComputerAccount>, pending: PendingRemoval[]): number {
  const used = [...Object.values(accounts).map(account => account.uid), ...pending.map(item => item.uid)];
  return Math.max(FIRST_ACCOUNT_UID - 1, ...used) + 1;
}

/** Input lines for RECONCILE_SCRIPT: removals first, then the wanted accounts. */
export function reconcileInput(accounts: Record<string, ComputerAccount>, pending: PendingRemoval[]): string {
  const lines = [
    ...pending.map(item => `rm ${item.uid} ${item.name}`),
    ...Object.entries(accounts).map(([profile, account]) => `add ${account.uid} ${accountName(profile)}`),
  ];
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Run as root in the computer. Brings /etc/passwd in line with the stored
 * accounts, matched by UID: creates missing accounts (after a rebuild their
 * home folders are already in the volume), renames accounts whose profile was
 * renamed, and deletes removed ones with their home folders. Names were
 * validated against NEW_PROFILE_NAME before they were stored.
 */
export const RECONCILE_SCRIPT = `set -e
install -d -m 1777 /tmp/.marifold-exec
user_of() { getent passwd "$1" | cut -d: -f1; }
group_of() { getent group "$1" | cut -d: -f1; }
while read -r op uid name; do
  [ -n "$op" ] || continue
  cur=$(user_of "$uid" || true)
  if [ "$op" = rm ]; then
    home=/home/$name
    if [ -n "$cur" ]; then
      home=$(getent passwd "$uid" | cut -d: -f6)
      pkill -KILL -u "$uid" || true
      userdel "$cur"
    fi
    g=$(group_of "$uid" || true); [ -z "$g" ] || groupdel "$g" || true
    case "$home" in /home/?*) rm -rf -- "$home" ;; esac
    continue
  fi
  if [ -z "$cur" ]; then
    if getent passwd "$name" >/dev/null; then echo "$name is already a system account on the agent computer" >&2; exit 3; fi
    g=$(group_of "$uid" || true)
    if [ -z "$g" ]; then groupadd -g "$uid" "$name"; elif [ "$g" != "$name" ]; then groupmod -n "$name" "$g"; fi
    useradd -u "$uid" -g "$uid" -G ${AGENTS_GROUP} -s /bin/bash -d "/home/$name" -M "$name"
  elif [ "$cur" != "$name" ]; then
    if getent passwd "$name" >/dev/null; then echo "$name is already a system account on the agent computer" >&2; exit 3; fi
    pkill -KILL -u "$uid" || true
    usermod -l "$name" "$cur"
    g=$(group_of "$uid" || true); [ -z "$g" ] || [ "$g" = "$name" ] || groupmod -n "$name" "$g"
    usermod -d "/home/$name" "$name"
  fi
  if [ ! -d "/home/$name" ]; then
    old=$(find /home -mindepth 1 -maxdepth 1 -type d -uid "$uid" | head -n 1)
    if [ -n "$old" ]; then mv -- "$old" "/home/$name"; else
      cp -rT /etc/skel "/home/$name"
      chown -R "$uid:$uid" "/home/$name"
      chmod 750 "/home/$name"
    fi
  fi
done
`;
