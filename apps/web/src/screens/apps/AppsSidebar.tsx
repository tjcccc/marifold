import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ApiClient } from '../../api/client';
import type { SkillAppDefinition } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { WorkspaceSidebar } from '../agent/WorkspaceSidebar';
import styles from '../agent/ProfileSidebar.module.css';
import appStyles from './AppsSidebar.module.css';

export interface AppsSidebarProps {
  client: ApiClient;
  apps: SkillAppDefinition[];
  selected?: string;
  busy?: boolean;
  loading?: boolean;
  onSelect: (name: string) => void;
  footer?: ReactNode;
}

/** Root Apps navigation, intentionally matching the Agent profile catalog. */
export function AppsSidebar(props: AppsSidebarProps) {
  const { footer, ...contentProps } = props;
  return (
    <WorkspaceSidebar ariaLabel="Apps" footer={footer} showBrand>
      <AppsSidebarContent {...contentProps} />
    </WorkspaceSidebar>
  );
}

export type AppsSidebarContentProps = Omit<AppsSidebarProps, 'footer'>;

/** App-specific catalog body for the persistent workspace sidebar. */
export function AppsSidebarContent({
  client,
  apps,
  selected,
  busy = false,
  loading = false,
  onSelect,
}: AppsSidebarContentProps) {
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const filteredApps = useMemo(() => {
    const terms = normalizeSearch(search).split(' ').filter(Boolean);
    if (terms.length === 0) return apps;
    return apps.filter(app => {
      const haystack = normalizeSearch([
        app.app.name,
        app.app.title,
        app.app.description ?? '',
      ].join(' '));
      return terms.every(term => haystack.includes(term));
    });
  }, [apps, search]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape' && search) {
      event.preventDefault();
      setSearch('');
      return;
    }
    if (event.key !== 'ArrowDown') return;
    const firstApp = listRef.current?.querySelector<HTMLButtonElement>('[data-app-row]');
    if (!firstApp) return;
    event.preventDefault();
    firstApp.focus();
  }

  return (
    <>
      <div className={styles.searchWrap}>
        <SearchGlyph />
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search apps"
          aria-label="Search apps"
          aria-controls="app-list"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>
      <div className={styles.header}>Apps</div>
      <div ref={listRef} id="app-list" className={styles.list}>
        {filteredApps.length === 0 ? (
          <div className={styles.empty} role="status">
            {loading ? 'Loading apps…' : apps.length === 0 ? 'No apps yet.' : 'No matching apps.'}
          </div>
        ) : null}
        {filteredApps.map(app => (
          <div
            key={app.app.name}
            className={app.app.name === selected ? styles.rowSelected : styles.row}
          >
            <button
              data-app-row
              className={`${styles.rowMain} ${appStyles.rowMain}`}
              disabled={busy}
              onClick={() => onSelect(app.app.name)}
              type="button"
            >
              <Avatar client={client} name={app.app.title} hasAvatar={false} size={40} />
              <span className={styles.meta}>
                <span className={styles.nameLine}>
                  <span className={styles.name}>{app.app.title}</span>
                </span>
                <span className={styles.sub}>{app.app.description ?? app.app.name}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
    </>
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
