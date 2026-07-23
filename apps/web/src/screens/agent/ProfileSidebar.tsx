import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
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
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const filteredProfiles = useMemo(() => {
    const terms = normalizeSearch(search).split(' ').filter(Boolean);
    if (terms.length === 0) return profiles;
    return profiles.filter(profile => {
      const name = normalizeSearch(profile.name);
      return terms.every(term => name.includes(term));
    });
  }, [profiles, search]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape' && search) {
      event.preventDefault();
      setSearch('');
      return;
    }
    if (event.key !== 'ArrowDown') return;
    const firstProfile = listRef.current?.querySelector<HTMLButtonElement>('[data-profile-row]');
    if (!firstProfile) return;
    event.preventDefault();
    firstProfile.focus();
  }

  return (
    <nav className={styles.pane} aria-label="Profiles">
      <SidebarBrand prominent />
      <div className={styles.searchWrap}>
        <SearchGlyph />
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search profiles"
          aria-label="Search profiles"
          aria-controls="profile-list"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>
      <div className={styles.header}>
        <span>Profiles</span>
        {onCreate ? (
          <button className={styles.newButton} onClick={onCreate} title="New profile">
            +
          </button>
        ) : null}
      </div>
      <div ref={listRef} id="profile-list" className={styles.list}>
        {filteredProfiles.length === 0 ? (
          <div className={styles.empty} role="status">
            {profiles.length === 0 ? 'No profiles yet.' : 'No matching profiles.'}
          </div>
        ) : null}
        {filteredProfiles.map(profile => {
          const working = workingProfiles?.has(profile.name) ?? false;
          return (
            <button
              key={profile.name}
              data-profile-row
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

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.2 10.2 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
