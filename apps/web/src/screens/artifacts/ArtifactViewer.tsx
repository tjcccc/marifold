import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import {
  type ArtifactDetail,
  type ArtifactFolder,
  type ArtifactView,
  artifactViewUrl,
  deleteArtifact,
  getArtifact,
  restoreArtifactVersion,
  undeleteArtifact,
  updateArtifact,
  viewArtifact,
} from '../../api/artifacts';
import { Markdown } from '../../components/Markdown';
import { formatRelativeTime } from '../../lib/format';
import styles from './ArtifactViewer.module.css';

/** The iframe's sandbox matches the CSP the service sends: scripts and
 * popups, never the app's origin. */
const FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

export interface ArtifactViewerProps {
  client: ApiClient;
  artifactId: string;
  /** The Artifacts view's pane (every action), or the conversation's column. */
  variant: 'pane' | 'column';
  folders?: ArtifactFolder[];
  /** After a rename, move, version, delete or restore; undefined once purged. */
  onChanged?: (artifact?: ArtifactDetail) => void;
  onOpenSession?: (artifact: ArtifactDetail) => void;
  onClose?: () => void;
}

/** One artifact: HTML in a sandboxed frame, Markdown through the app's own
 * renderer with the bundle's images, with versions and library actions. */
export function ArtifactViewer({ client, artifactId, variant, folders = [], onChanged, onOpenSession, onClose }: ArtifactViewerProps) {
  const [artifact, setArtifact] = useState<ArtifactDetail>();
  const [version, setVersion] = useState<number>();
  const [view, setView] = useState<ArtifactView>();
  const [markdown, setMarkdown] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [confirmPurge, setConfirmPurge] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getArtifact(client, artifactId);
      setArtifact(next);
      setProblem(undefined);
      return next;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }, [client, artifactId]);

  useEffect(() => {
    setArtifact(undefined);
    setVersion(undefined);
    setRenaming(undefined);
    setConfirmPurge(false);
    void load();
  }, [load]);

  const shown = version ?? artifact?.currentVersion;
  // A fresh ticket for every opening: an expired one is refused before it can say so.
  useEffect(() => {
    if (!artifact || shown === undefined) { return; }
    let cancelled = false;
    setView(undefined);
    setMarkdown(undefined);
    void viewArtifact(client, artifact.id, shown).then(async next => {
      if (cancelled) { return; }
      setView(next);
      if (!artifact.seen && shown === artifact.currentVersion) { onChanged?.({ ...artifact, seen: true }); }
      if (next.kind === 'markdown') {
        const response = await fetch(artifactViewUrl(client, next.entryPath));
        const text = response.ok ? await response.text() : undefined;
        if (!cancelled) { setMarkdown(text ?? ''); }
      }
    }).catch(error => { if (!cancelled) { setProblem(error instanceof Error ? error.message : String(error)); } });
    return () => { cancelled = true; };
  }, [client, artifact?.id, artifact?.currentVersion, shown]);

  async function act(action: () => Promise<ArtifactDetail | undefined>): Promise<void> {
    try {
      const next = await action();
      if (next) { setArtifact(next); setVersion(undefined); }
      onChanged?.(next);
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  if (!artifact) {
    return <div className={styles.viewer}><div className={styles.status} role="status">{problem ?? 'Opening…'}</div></div>;
  }
  const deleted = artifact.deletedAt !== undefined;
  const pageUrl = view ? artifactViewUrl(client, view.entryPath) : undefined;
  const current = artifact.versions.find(item => item.version === shown);
  const resolveImage = (src: string) => view ? bundleImageUrl(client, view, src) : undefined;

  return (
    <div className={variant === 'pane' ? styles.viewer : `${styles.viewer} ${styles.column}`}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          {renaming !== undefined ? (
            <form className={styles.renameForm} onSubmit={event => {
              event.preventDefault();
              const title = renaming.trim();
              setRenaming(undefined);
              if (title && title !== artifact.title) { void act(() => updateArtifact(client, artifact.id, { title })); }
            }}>
              <input className={styles.renameInput} aria-label="Artifact title" value={renaming} autoFocus maxLength={200}
                onChange={event => setRenaming(event.target.value)} onBlur={event => event.currentTarget.form?.requestSubmit()}
                onKeyDown={event => { if (event.key === 'Escape') { setRenaming(undefined); } }} />
            </form>
          ) : (
            <h2 className={styles.title} title={artifact.title}>
              {variant === 'pane' && !deleted ? (
                <button type="button" className={styles.titleButton} aria-label={`Rename ${artifact.title}`} onClick={() => setRenaming(artifact.title)}>{artifact.title}</button>
              ) : artifact.title}
            </h2>
          )}
          {onClose ? <button type="button" className={styles.iconButton} aria-label="Close artifact" onClick={onClose}>×</button> : null}
        </div>
        <div className={styles.meta}>
          {artifact.kind === 'html' ? 'Page' : 'Document'} · v{shown}
          {current?.createdBy ? ` · ${current.createdBy}` : ''}
          {current ? ` · ${formatRelativeTime(current.createdAt)}` : ''}
          {deleted ? ' · In Recently deleted' : ''}
        </div>
        <div className={styles.actions}>
          {artifact.versions.length > 1 ? (
            <select className={styles.select} aria-label="Version" value={shown} onChange={event => setVersion(Number(event.target.value))}>
              {[...artifact.versions].reverse().map(item => (
                <option key={item.version} value={item.version}>v{item.version}{item.version === artifact.currentVersion ? ' (current)' : ''}{item.note ? ` — ${item.note}` : ''}</option>
              ))}
            </select>
          ) : null}
          {shown !== artifact.currentVersion && !deleted ? (
            <button type="button" className={styles.button} onClick={() => void act(() => restoreArtifactVersion(client, artifact.id, shown!))}>Restore this version</button>
          ) : null}
          {variant === 'pane' && !deleted ? (
            <select className={styles.select} aria-label="Folder" value={artifact.folderId ?? ''}
              onChange={event => void act(() => updateArtifact(client, artifact.id, { folderId: event.target.value || null }))}>
              <option value="">Unfiled</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          ) : null}
          {pageUrl ? <a className={styles.button} href={pageUrl} target="_blank" rel="noopener noreferrer">Open in new tab</a> : null}
          {pageUrl ? <a className={styles.button} href={pageUrl} download={view?.entry.split('/').pop()}>Download</a> : null}
          {onOpenSession && artifact.sessionId ? <button type="button" className={styles.button} onClick={() => onOpenSession(artifact)}>Open session</button> : null}
          {variant === 'pane' && !deleted ? (
            <button type="button" className={styles.dangerButton} onClick={() => void act(async () => { await deleteArtifact(client, artifact.id); return load(); })}>Delete</button>
          ) : null}
          {deleted ? (
            <>
              <button type="button" className={styles.button} onClick={() => void act(() => undeleteArtifact(client, artifact.id))}>Put back</button>
              {confirmPurge ? (
                <button type="button" className={styles.dangerButton} onClick={() => void act(async () => { await deleteArtifact(client, artifact.id, true); return undefined; })}>Delete forever — confirm</button>
              ) : (
                <button type="button" className={styles.dangerButton} onClick={() => setConfirmPurge(true)}>Delete forever</button>
              )}
            </>
          ) : null}
        </div>
        {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}
      </header>
      <div className={styles.body}>
        {!view ? (
          <div className={styles.status} role="status">Loading…</div>
        ) : view.kind === 'html' ? (
          <iframe key={view.entryPath} className={styles.frame} title={artifact.title} src={pageUrl} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" />
        ) : markdown === undefined ? (
          <div className={styles.status} role="status">Loading…</div>
        ) : (
          <div className={styles.document}><Markdown source={markdown} resolveImage={resolveImage} /></div>
        )}
      </div>
    </div>
  );
}

/** A Markdown image's URL inside the bundle: relative paths only, resolved
 * against the entry file; anything absolute or remote shows its alt text. */
export function bundleImageUrl(client: ApiClient, view: Pick<ArtifactView, 'path' | 'entry'>, src: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\')) { return undefined; }
  const resolved = new URL(src, `http://bundle/${view.entry}`);
  if (resolved.host !== 'bundle' || resolved.pathname === '/') { return undefined; }
  return artifactViewUrl(client, `${view.path}${resolved.pathname.slice(1)}`);
}
