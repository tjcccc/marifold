import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { type ArtifactSummary, listArtifacts } from '../../api/artifacts';
import { formatRelativeTime } from '../../lib/format';
import styles from './ProjectAssetsPanel.module.css';

export interface ProjectArtifactsCardProps {
  client: ApiClient;
  projectId: string;
  /** A reply ending reloads the list, since it may have saved one. */
  responding: boolean;
  touch: boolean;
  onOpen: (artifactId: string) => void;
}

/** The project's artifacts in its Assets column (docs/artifacts.md#web-ui):
 * pages profiles made in this project's sessions, opened in the viewer. */
export function ProjectArtifactsCard({ client, projectId, responding, touch, onOpen }: ProjectArtifactsCardProps) {
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<ArtifactSummary[]>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (responding) { return; }
    let cancelled = false;
    listArtifacts(client, { projectId }).then(
      list => { if (!cancelled) { setItems(list); setProblem(undefined); } },
      error => { if (!cancelled) { setProblem(error instanceof Error ? error.message : String(error)); } },
    );
    return () => { cancelled = true; };
  }, [client, projectId, responding]);

  const unread = items?.filter(item => !item.seen).length ?? 0;
  return (
    <section className={styles.card} aria-label="Artifacts">
      <div className={styles.cardHeader}>
        <button type="button" className={styles.cardToggle} aria-expanded={open} onClick={() => setOpen(current => !current)}>
          <ChevronGlyph open={open} />
          <span className={styles.cardTitle}>Artifacts</span>
          <span className={styles.spacer} />
          <span className={styles.summary}>
            {items === undefined ? (problem ? '' : 'Loading…') : items.length === 0 ? 'none yet' : `${items.length}${unread > 0 ? ` · ${unread} unread` : ''}`}
          </span>
        </button>
      </div>
      {open ? (
        <div className={styles.rows}>
          {problem ? <div className={styles.problemText} role="alert">{problem}</div> : null}
          {items?.length === 0 ? <div className={styles.empty}>Pages and documents profiles make in this project appear here.</div> : null}
          {items?.map(item => (
            <button key={item.id} type="button" className={`${styles.row} ${styles.rowButton}`} data-touch={touch || undefined} onClick={() => onOpen(item.id)}>
              <span className={styles.tile} aria-hidden>{item.kind === 'html' ? '◫' : '¶'}</span>
              <span className={styles.rowText}>
                <span className={styles.rowName} title={item.description ?? item.title}>{item.title}</span>
                <span className={styles.rowMeta}>
                  {item.kind === 'html' ? 'Page' : 'Document'} · v{item.currentVersion}{item.createdBy ? ` · ${item.createdBy}` : ''} · {formatRelativeTime(item.updatedAt)}
                </span>
              </span>
              {!item.seen ? <span className={styles.unreadDot} aria-label="Unread" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
      <path d={open ? 'M3 4.5 6 7.5 9 4.5' : 'M4.5 3 7.5 6 4.5 9'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
