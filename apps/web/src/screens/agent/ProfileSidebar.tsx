import type { ReactNode } from 'react';
import type { ApiClient } from '../../api/client';
import type { ProfileSummary } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { SidebarBrand } from '../../components/SidebarChrome';
import styles from './ProfileSidebar.module.css';

export interface ProfileSidebarProps {
  client: ApiClient;
  profiles: ProfileSummary[];
  selected?: string;
  /** Profiles with a run currently working (live sub-line). */
  workingProfiles?: ReadonlySet<string>;
  onSelect: (name: string) => void;
  onCreate?: () => void;
  footer?: ReactNode;
}

/** Root of the primary sidebar navigation stack: Marifold → profiles. */
export function ProfileSidebar({ client, profiles, selected, workingProfiles, onSelect, onCreate, footer }: ProfileSidebarProps) {
  return (
    <nav className={styles.pane} aria-label="Profiles">
      <SidebarBrand prominent />
      <div className={styles.header}>
        <span>Profiles</span>
        {onCreate ? (
          <button className={styles.newButton} onClick={onCreate} title="New profile">
            +
          </button>
        ) : null}
      </div>
      <div className={styles.list}>
        {profiles.map(profile => {
          const working = workingProfiles?.has(profile.name) ?? false;
          return (
            <button
              key={profile.name}
              className={profile.name === selected ? styles.rowSelected : styles.row}
              onClick={() => onSelect(profile.name)}
            >
              <Avatar client={client} name={profile.name} hasAvatar={profile.avatar !== undefined} size={32} />
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
      {footer}
    </nav>
  );
}
