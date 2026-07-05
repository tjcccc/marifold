import type { ProfileSummary } from '../../api/types';
import styles from './ProfileSidebar.module.css';

export interface ProfileSidebarProps {
  profiles: ProfileSummary[];
  selected?: string;
  /** Profiles with a run currently working (live sub-line). */
  workingProfiles?: ReadonlySet<string>;
  onSelect: (name: string) => void;
}

/** Contacts-style profile list (design 1a left pane). */
export function ProfileSidebar({ profiles, selected, workingProfiles, onSelect }: ProfileSidebarProps) {
  return (
    <nav className={styles.pane} aria-label="Profiles">
      <div className={styles.header}>Profiles</div>
      <div className={styles.list}>
        {profiles.map(profile => {
          const working = workingProfiles?.has(profile.name) ?? false;
          return (
            <button
              key={profile.name}
              className={profile.name === selected ? styles.rowSelected : styles.row}
              onClick={() => onSelect(profile.name)}
            >
              <span className={styles.avatar} aria-hidden>
                {profile.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={styles.meta}>
                <span className={styles.name}>{profile.name}</span>
                <span className={working ? styles.working : styles.sub}>
                  {working ? 'Working…' : profile.source === 'built-in' ? 'built-in' : 'ready'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
