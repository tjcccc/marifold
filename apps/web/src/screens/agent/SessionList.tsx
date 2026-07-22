import type { ReactNode } from 'react';
import type { SessionSummary } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import styles from './SessionList.module.css';

export interface SessionListProps {
  sessions: SessionSummary[];
  selected?: string;
  profileName: string;
  profileAvatar?: ReactNode;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  footer?: ReactNode;
}

/** Second level of the primary sidebar stack: selected profile → sessions. */
export function SessionList({ sessions, selected, profileName, profileAvatar, onSelect, onNew, onBack, footer }: SessionListProps) {
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
        {sessions.map(session => (
          <button
            key={session.id}
            className={session.id === selected ? styles.rowSelected : styles.row}
            onClick={() => onSelect(session.id)}
          >
            <span className={styles.title}>{sessionTitle(session)}</span>
            <span className={styles.sub}>
              {formatRelativeTime(session.updatedAt)} · {session.turnCount} turns
            </span>
          </button>
        ))}
      </div>
      {footer}
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

/** First-message preview when the server has one; timestamp otherwise. */
export function sessionTitle(session: SessionSummary): string {
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
