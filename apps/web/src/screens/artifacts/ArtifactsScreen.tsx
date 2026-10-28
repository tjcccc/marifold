import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { type ArtifactDetail, type ArtifactScope, type ArtifactSummary, listArtifacts } from '../../api/artifacts';
import { formatRelativeTime } from '../../lib/format';
import { ArtifactViewer } from './ArtifactViewer';
import type { ArtifactLibraryState } from './useArtifactLibrary';
import styles from './ArtifactsScreen.module.css';

export interface ArtifactsScreenProps {
  client: ApiClient;
  library: ArtifactLibraryState;
  /** `all`, `unread`, `unfiled`, `deleted`, or a folder id. */
  folder: string;
  artifactId?: string;
  /** Phone: the list, or the open artifact, fills the pane. */
  mobile: boolean;
  onOpen: (artifactId?: string) => void;
  onOpenSession: (artifact: ArtifactDetail) => void;
}

/** The Artifacts view's list and viewer columns (docs/artifacts.md#web-ui). */
export function ArtifactsScreen({ client, library, folder, artifactId, mobile, onOpen, onOpenSession }: ArtifactsScreenProps) {
  const [items, setItems] = useState<ArtifactSummary[]>();
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string>();
  const scope: ArtifactScope = folder === 'all' || folder === 'unread' || folder === 'unfiled' || folder === 'deleted' ? folder : { folderId: folder };
  const scopeKey = typeof scope === 'string' ? scope : scope.folderId;

  const refresh = useCallback(async () => {
    try {
      setItems(await listArtifacts(client, scope, search));
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [client, scopeKey, search]);
  useEffect(() => { void refresh(); }, [refresh]);

  const changed = (artifact?: ArtifactDetail) => {
    if (artifact) { setItems(current => current?.map(item => item.id === artifact.id ? { ...item, ...artifact } : item)); }
    void refresh();
    void library.refresh();
    if (!artifact) { onOpen(undefined); }
  };

  const list = (
    <section className={styles.list} aria-label="Artifacts">
      <div className={styles.searchWrap}>
        <input className={styles.search} type="search" placeholder="Search titles" aria-label="Search artifacts" value={search} onChange={event => setSearch(event.target.value)} />
      </div>
      {folder === 'deleted' ? <div className={styles.note}>Deleted artifacts are removed for good after 30 days.</div> : null}
      {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}
      {items === undefined ? <div className={styles.empty} role="status">Loading…</div> : items.length === 0 ? (
        <div className={styles.empty}>{search ? 'No matching artifacts.' : folder === 'deleted' ? 'Nothing was deleted recently.' : 'No artifacts here yet. Ask a profile for a report or page to keep, or save one from a run’s files.'}</div>
      ) : (
        <ul className={styles.rows}>
          {items.map(item => (
            <li key={item.id}>
              <button type="button" className={item.id === artifactId ? styles.rowSelected : styles.row} aria-current={item.id === artifactId ? 'true' : undefined} onClick={() => onOpen(item.id)}>
                <span className={styles.kind} aria-hidden>{item.kind === 'html' ? '◫' : '¶'}</span>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowMeta}>
                    {item.kind === 'html' ? 'Page' : 'Document'} · v{item.currentVersion}{item.createdBy ? ` · ${item.createdBy}` : ''} · {formatRelativeTime(item.deletedAt ?? item.updatedAt)}
                  </span>
                </span>
                {!item.seen && folder !== 'deleted' ? <span className={styles.unread} aria-label="Unread" /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const viewer = artifactId ? (
    <ArtifactViewer key={artifactId} client={client} artifactId={artifactId} variant="pane" folders={library.folders} onChanged={changed} onOpenSession={onOpenSession} />
  ) : (
    <div className={styles.placeholder}>Choose an artifact to read it.</div>
  );

  if (mobile) { return <div className={styles.screen}>{artifactId ? viewer : list}</div>; }
  return <div className={styles.screen}>{list}{viewer}</div>;
}
