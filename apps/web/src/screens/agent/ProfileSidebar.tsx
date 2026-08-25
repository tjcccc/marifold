import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../../api/client';
import type { ProfileSummary } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { PinGlyph } from '../../components/PinGlyph';
import { formatRelativeTime } from '../../lib/format';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import styles from './ProfileSidebar.module.css';

export interface ProfileSidebarProps {
  client: ApiClient;
  profiles: ProfileSummary[];
  selected?: string;
  /** Profiles with a run currently working (live sub-line). */
  workingProfiles?: ReadonlySet<string>;
  onSelect: (name: string) => void;
  onSetPinned?: (name: string, pinned: boolean) => Promise<boolean>;
  onConfigure?: (name: string) => void;
  onCreate?: () => void;
  footer?: ReactNode;
}

interface MenuState {
  profile: ProfileSummary;
  top: number;
  left: number;
  trigger: HTMLButtonElement;
}

const MENU_WIDTH = 168;

/** Root of the primary sidebar navigation stack: Marifold → profiles. */
export function ProfileSidebar(props: ProfileSidebarProps) {
  const { footer, ...contentProps } = props;
  return (
    <WorkspaceSidebar ariaLabel="Profiles" footer={footer} showBrand>
      <ProfileSidebarContent {...contentProps} />
    </WorkspaceSidebar>
  );
}

export type ProfileSidebarContentProps = Omit<ProfileSidebarProps, 'footer'>;

/** Profile-specific catalog body for the persistent workspace sidebar. */
export function ProfileSidebarContent({
  client,
  profiles,
  selected,
  workingProfiles,
  onSelect,
  onSetPinned,
  onConfigure,
  onCreate,
}: ProfileSidebarContentProps) {
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filteredProfiles = useMemo(() => {
    const terms = normalizeSearch(search).split(' ').filter(Boolean);
    if (terms.length === 0) return profiles;
    return profiles.filter(profile => {
      const identity = normalizeSearch(`${profile.displayName} ${profile.name}`);
      return terms.every(term => identity.includes(term));
    });
  }, [profiles, search]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menu?.trigger.contains(target)) return;
      setMenu(undefined);
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenu(undefined);
        menu?.trigger.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    }
    function onScroll(): void {
      setMenu(undefined);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);

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

  function toggleMenu(profile: ProfileSummary, trigger: HTMLButtonElement): void {
    if (menu?.profile.name === profile.name) {
      setMenu(undefined);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 90));
    setMenu({ profile, left, top, trigger });
  }

  async function togglePinned(profile: ProfileSummary): Promise<void> {
    if (!onSetPinned || busy) return;
    setBusy(true);
    const saved = await onSetPinned(profile.name, !profile.pinned);
    setBusy(false);
    if (saved) setMenu(undefined);
  }

  return (
    <>
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
          const activityTime = !working && profile.preview && profile.updatedAt
            ? formatRelativeTime(profile.updatedAt)
            : '';
          return (
            <div
              key={profile.name}
              className={profile.name === selected ? styles.rowSelected : styles.row}
            >
              <button
                data-profile-row
                className={styles.rowMain}
                onClick={() => onSelect(profile.name)}
              >
                <Avatar
                  client={client}
                  name={profile.name}
                  label={profile.displayName}
                  hasAvatar={profile.avatar !== undefined}
                  size={40}
                />
                <span className={styles.meta}>
                  <span className={styles.nameLine}>
                    <span className={styles.name}>{profile.displayName}</span>
                    {profile.pinned ? (
                      <span className={styles.pinIndicator} title="Pinned"><PinGlyph /></span>
                    ) : null}
                    {activityTime ? (
                      <time
                        className={styles.activityTime}
                        dateTime={profile.updatedAt}
                        title={new Date(profile.updatedAt!).toLocaleString()}
                      >
                        {activityTime}
                      </time>
                    ) : null}
                  </span>
                  <span className={working ? styles.working : styles.sub}>
                    {working ? 'Working…' : profile.preview ?? 'No recent response'}
                  </span>
                </span>
              </button>
              {onSetPinned || onConfigure ? (
                <button
                  className={styles.moreButton}
                  title={`Profile actions for ${profile.displayName}`}
                  aria-label={`Profile actions for ${profile.displayName}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.profile.name === profile.name}
                  onClick={event => toggleMenu(profile, event.currentTarget)}
                >
                  <MoreGlyph />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {menu ? createPortal(
        <div
          ref={menuRef}
          className={styles.actionMenu}
          role="menu"
          aria-label={`Actions for ${menu.profile.displayName}`}
          style={{ top: menu.top, left: menu.left }}
        >
          {onSetPinned ? (
            <button
              className={styles.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={() => void togglePinned(menu.profile)}
            >
              <PinGlyph />
              <span>{menu.profile.pinned ? 'Unpin' : 'Pin'}</span>
            </button>
          ) : null}
          {onConfigure ? (
            <button
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setMenu(undefined);
                onConfigure(menu.profile.name);
              }}
            >
              <ConfigGlyph />
              <span>Config</span>
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
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

function MoreGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="3" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="13" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function ConfigGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 1.8v1.4M8 12.8v1.4M14.2 8h-1.4M3.2 8H1.8M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
