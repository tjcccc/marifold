import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import styles from './SessionList.module.css';

const MENU_WIDTH = 184;

export interface SessionListProps {
  sessions: SessionSummary[];
  selected?: string;
  profileName: string;
  profileAvatar?: ReactNode;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onSetPinned: (id: string, pinned: boolean) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  footer?: ReactNode;
}

interface MenuState {
  session: SessionSummary;
  top: number;
  left: number;
  trigger: HTMLButtonElement;
}

/** Second level of the primary sidebar stack: selected profile → sessions. */
export function SessionList({
  sessions,
  selected,
  profileName,
  profileAvatar,
  onSelect,
  onNew,
  onBack,
  onRename,
  onSetPinned,
  onDelete,
  footer,
}: SessionListProps) {
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [renaming, setRenaming] = useState<SessionSummary | undefined>();
  const [deleting, setDeleting] = useState<SessionSummary | undefined>();
  const [titleDraft, setTitleDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menu?.trigger.contains(target)) return;
      setMenu(undefined);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenu(undefined);
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

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (!renaming && !deleting) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || busy) return;
      setRenaming(undefined);
      setDeleting(undefined);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, deleting, renaming]);

  function toggleMenu(session: SessionSummary, trigger: HTMLButtonElement): void {
    if (menu?.session.id === session.id) {
      setMenu(undefined);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 156));
    setMenu({ session, left, top, trigger });
  }

  async function submitRename(): Promise<void> {
    if (!renaming || !titleDraft.trim() || busy) return;
    setBusy(true);
    const saved = await onRename(renaming.id, titleDraft.trim());
    setBusy(false);
    if (saved) setRenaming(undefined);
  }

  async function togglePinned(session: SessionSummary): Promise<void> {
    if (busy) return;
    setBusy(true);
    const saved = await onSetPinned(session.id, !session.pinned);
    setBusy(false);
    if (saved) setMenu(undefined);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting || busy) return;
    setBusy(true);
    const deleted = await onDelete(deleting.id);
    setBusy(false);
    if (deleted) setDeleting(undefined);
  }

  return (
    <section className={styles.pane} aria-label="Sessions">
      <div className={styles.profileHeader}>
        <button className={styles.backButton} onClick={onBack} title="Back to profiles" aria-label="Back to profiles">
          <BackGlyph />
        </button>
        <span className={styles.profileName}>{profileName}</span>
      </div>
      {profileAvatar ? <div className={styles.profileHero}>{profileAvatar}</div> : null}
      <div className={styles.header}>
        <span>Sessions</span>
        <button className={styles.newButton} onClick={onNew} title="New session">
          +
        </button>
      </div>
      <div className={styles.list}>
        {sessions.length === 0 ? <div className={styles.empty}>No sessions yet.</div> : null}
        {sessions.map(session => {
          const title = sessionTitle(session);
          return (
            <div
              key={session.id}
              className={session.id === selected ? styles.rowSelected : styles.row}
            >
              <button className={styles.rowMain} onClick={() => onSelect(session.id)}>
                <span className={styles.titleLine}>
                  <span className={styles.title}>{title}</span>
                  {session.pinned ? <span className={styles.pinIndicator} title="Pinned"><PinGlyph /></span> : null}
                </span>
                <span className={styles.sub}>
                  {formatRelativeTime(session.updatedAt)} · {session.turnCount} turns
                </span>
              </button>
              <button
                className={styles.moreButton}
                title={`Session actions for ${title}`}
                aria-label={`Session actions for ${title}`}
                aria-haspopup="menu"
                aria-expanded={menu?.session.id === session.id}
                onClick={event => toggleMenu(session, event.currentTarget)}
              >
                <MoreGlyph />
              </button>
            </div>
          );
        })}
      </div>
      {footer}

      {menu ? createPortal(
        <div
          ref={menuRef}
          className={styles.actionMenu}
          role="menu"
          aria-label={`Actions for ${sessionTitle(menu.session)}`}
          style={{ top: menu.top, left: menu.left }}
        >
          <button
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              setTitleDraft(sessionTitle(menu.session));
              setRenaming(menu.session);
              setMenu(undefined);
            }}
          >
            <RenameGlyph />
            <span>Rename</span>
          </button>
          <button
            className={styles.menuItem}
            role="menuitem"
            disabled={busy}
            onClick={() => void togglePinned(menu.session)}
          >
            <PinGlyph />
            <span>{menu.session.pinned ? 'Unpin' : 'Pin'}</span>
          </button>
          <div className={styles.menuSeparator} />
          <button
            className={styles.menuItemDanger}
            role="menuitem"
            onClick={() => {
              setDeleting(menu.session);
              setMenu(undefined);
            }}
          >
            <TrashGlyph />
            <span>Delete</span>
          </button>
        </div>,
        document.body,
      ) : null}

      {renaming ? createPortal(
        <div className={styles.dialogBackdrop} onClick={() => { if (!busy) setRenaming(undefined); }}>
          <form
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-session-title"
            onClick={event => event.stopPropagation()}
            onSubmit={event => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <div id="rename-session-title" className={styles.dialogTitle}>Rename session</div>
            <input
              ref={renameInputRef}
              className={styles.renameInput}
              aria-label="Session name"
              maxLength={200}
              value={titleDraft}
              onChange={event => setTitleDraft(event.target.value)}
            />
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogCancel} disabled={busy} onClick={() => setRenaming(undefined)}>
                Cancel
              </button>
              <button type="submit" className={styles.dialogPrimary} disabled={busy || !titleDraft.trim()}>
                {busy ? 'Saving…' : 'Rename'}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

      {deleting ? createPortal(
        <div className={styles.dialogBackdrop} onClick={() => { if (!busy) setDeleting(undefined); }}>
          <div
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            aria-describedby="delete-session-description"
            onClick={event => event.stopPropagation()}
          >
            <div id="delete-session-title" className={styles.dialogTitle}>Delete session?</div>
            <div id="delete-session-description" className={styles.dialogDescription}>
              “{sessionTitle(deleting)}” and its full transcript will be permanently deleted.
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogCancel} disabled={busy} onClick={() => setDeleting(undefined)}>
                Cancel
              </button>
              <button type="button" className={styles.dialogDelete} disabled={busy} onClick={() => void confirmDelete()}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

function BackGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="m9.8 3.4-4.6 4.6 4.6 4.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="4" cy="9" r="1.15" fill="currentColor" />
      <circle cx="9" cy="9" r="1.15" fill="currentColor" />
      <circle cx="14" cy="9" r="1.15" fill="currentColor" />
    </svg>
  );
}

function RenameGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
      <path d="m4 12.8-.6 2.2 2.2-.6 7.8-7.8-1.6-1.6L4 12.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m10.9 5.9 1.6 1.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
      <path d="m6.2 3.3 5.5 5.5-1.6 1.6.2 2.1-1 1-2.4-2.4-3.4 3.4-.8-.8 3.4-3.4-2.4-2.4 1-1 2.1.2 1.6-1.6" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
      <path d="M4.5 5.5h9M7 3.5h4M6 5.5l.5 9h5l.5-9M8 8v4.2M10 8v4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Custom title, then first-message preview, then timestamp fallback. */
export function sessionTitle(session: SessionSummary): string {
  if (session.title) return session.title;
  if (session.preview) return session.preview;
  const created = new Date(session.createdAt);
  if (Number.isNaN(created.getTime())) return session.id.slice(0, 8);
  return created.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
