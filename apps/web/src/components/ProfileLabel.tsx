import type { ApiClient } from '../api/client';
import type { ProfileSummary } from '../api/types';
import { Avatar } from './Avatar';
import styles from './ProfileLabel.module.css';

/** A profile's avatar and display name, e.g. above a project reply. A profile
 * that no longer exists shows its stored name; an `inactive` one (e.g.
 * dismissed from the project) shows its avatar in monochrome. */
export function ProfileLabel({ client, name, profiles, size = 22, inactive = false }: {
  client: ApiClient;
  name: string;
  profiles: ProfileSummary[];
  size?: number;
  inactive?: boolean;
}) {
  const profile = profiles.find(candidate => candidate.name === name);
  const label = profile?.displayName ?? name;
  return (
    <span className={styles.label} title={inactive ? `${label} is no longer in this project` : undefined}>
      <span className={inactive ? styles.avatarInactive : styles.avatar}>
        <Avatar client={client} name={name} label={label} hasAvatar={profile?.avatar !== undefined} size={size} />
      </span>
      <span className={styles.name}>{label}</span>
    </span>
  );
}

/** Small overlapping avatars of the profiles that spoke in a session; those
 * `inactive` (e.g. dismissed from its project) show in monochrome. */
export function ProfileStack({ client, names, profiles, max = 4, inactive }: {
  client: ApiClient;
  names: string[];
  profiles: ProfileSummary[];
  max?: number;
  inactive?: (name: string) => boolean;
}) {
  if (names.length === 0) { return null; }
  const shown = names.slice(0, max);
  const labels = names.map(name => {
    const label = profiles.find(profile => profile.name === name)?.displayName ?? name;
    return inactive?.(name) ? `${label} (no longer in this project)` : label;
  });
  return (
    <span className={styles.stack} title={labels.join(', ')} aria-label={`Replies from ${labels.join(', ')}`}>
      {shown.map(name => {
        const profile = profiles.find(candidate => candidate.name === name);
        return (
          <span key={name} className={inactive?.(name) ? styles.stackItemInactive : styles.stackItem}>
            <Avatar client={client} name={name} label={profile?.displayName ?? name} hasAvatar={profile?.avatar !== undefined} size={16} />
          </span>
        );
      })}
      {names.length > max ? <span className={styles.more}>+{names.length - max}</span> : null}
    </span>
  );
}
