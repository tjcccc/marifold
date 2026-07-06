import type { SessionSummary } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import styles from './SessionList.module.css';

export interface SessionListProps {
  sessions: SessionSummary[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

/** Middle column: the selected profile's sessions, newest first. */
export function SessionList({ sessions, selected, onSelect, onNew }: SessionListProps) {
  return (
    <section className={styles.pane} aria-label="Sessions">
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
    </section>
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
