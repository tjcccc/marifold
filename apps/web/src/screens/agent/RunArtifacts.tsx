import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { type ArtifactDetail, saveRunOutputAsArtifact } from '../../api/artifacts';
import type { RunArtifact } from '../../api/types';
import type { SavedArtifactChip } from '../../state/threadTypes';
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog';
import type { PreviewImage } from '../../components/ImagePreviewDialog';
import { ARTIFACT_UNAVAILABLE_NOTICE, downloadRunArtifact, isImageArtifact } from '../../lib/runArtifacts';
import { useArtifactDownloads } from './useArtifactDownloads';
import styles from './RunArtifacts.module.css';
import { artifactPreviewBlob } from '../../lib/artifactPreviewCache';
import { formatBytes } from '../../lib/format';

const SAVABLE = /\.(?:html?|md|markdown)$/i;

/** The library side of a run's files: chips that open what it saved, and
 * Save as artifact for a page or document among its outputs. */
export interface RunLibraryProps {
  saved?: SavedArtifactChip[];
  onOpenArtifact?: (id: string) => void;
  /** After Save as artifact, with what was saved. */
  onSavedArtifact?: (artifact: ArtifactDetail) => void;
}

/** Deliverables belong to the answer and remain visible independently of logs. */
export function RunArtifacts({ client, runId, artifacts, saved = [], onOpenArtifact, onSavedArtifact }: { client?: ApiClient; runId: string; artifacts: RunArtifact[] } & RunLibraryProps) {
  const { unavailable, downloading, started, error, download } = useArtifactDownloads(client, runId, artifacts);
  const [preview, setPreview] = useState<PreviewImage>();
  const [saving, setSaving] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  useEffect(() => { setPreview(undefined); }, [client, runId]);
  if (!artifacts.length && !saved.length) { return null; }
  async function saveAsArtifact(artifact: RunArtifact): Promise<void> {
    if (!client) { return; }
    setSaving(artifact.id);
    setSaveError(undefined);
    try {
      const created = await saveRunOutputAsArtifact(client, { runId, artifactId: artifact.id });
      onSavedArtifact?.(created);
    } catch (problem) {
      setSaveError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSaving(undefined);
    }
  }
  return (
    <section className={styles.files} aria-label="Generated files">
      {onOpenArtifact ? saved.map(item => (
        <button key={item.id} type="button" className={styles.libraryChip} aria-label={`Open artifact ${item.title}`} onClick={() => onOpenArtifact(item.id)}>
          <span aria-hidden className={styles.libraryGlyph}>{item.kind === 'html' ? '◫' : '¶'}</span>
          <span className={styles.label}>
            <span className={styles.name}>{item.title}</span>
            <span className={styles.detail}>Artifact · v{item.version} · Open</span>
          </span>
        </button>
      )) : null}
      {artifacts.map(artifact => {
        const missing = unavailable.has(artifact.id);
        // Already an artifact (by Save as artifact or the profile's own save): its chip opens it.
        const savedAs = saved.some(item => item.sourceOutput === artifact.id);
        const name = artifact.name.split('/').at(-1) || artifact.name;
        return (
          <div className={`${styles.file} ${isImageArtifact(artifact) ? styles.imageFile : ''}`} key={artifact.id}>
            {client && isImageArtifact(artifact) && !missing ? (
              <ArtifactThumbnail client={client} runId={runId} artifact={artifact} onPreview={(src, aspectRatio) => setPreview({
                src,
                aspectRatio,
                alt: name,
                loadBlob: () => artifactPreviewBlob(client, runId, artifact, 'viewer'),
                download: () => downloadRunArtifact(client, runId, artifact),
              })} />
            ) : null}
            <button className={styles.download} type="button" aria-label={`Download ${name}`}
              aria-busy={downloading === artifact.id}
              disabled={!client || missing || downloading === artifact.id} onClick={() => void download(artifact)}>
              <span aria-hidden>{isImageArtifact(artifact) ? '▧' : '▤'}</span>
              <span className={styles.label}>
                <span className={styles.name}>{name}</span>
                <span className={styles.detail} aria-live="polite">{missing ? 'Unavailable' : downloading === artifact.id ? 'Starting download…' : started === artifact.id ? 'Download started' : 'Download'} · {formatBytes(artifact.size)}</span>
              </span>
              <span aria-hidden className={downloading === artifact.id ? styles.spinner : started === artifact.id ? styles.started : undefined}>
                {downloading === artifact.id ? '' : started === artifact.id ? '✓' : '↓'}
              </span>
            </button>
            {savedAs && onSavedArtifact ? (
              <button type="button" className={styles.saveArtifact} disabled>Saved as artifact</button>
            ) : onSavedArtifact && SAVABLE.test(artifact.name) && !missing ? (
              <button type="button" className={styles.saveArtifact} disabled={!client || saving === artifact.id} aria-busy={saving === artifact.id}
                onClick={() => void saveAsArtifact(artifact)}>
                {saving === artifact.id ? 'Saving…' : 'Save as artifact'}
              </button>
            ) : null}
            {missing ? <p className={styles.notice} role="status">{ARTIFACT_UNAVAILABLE_NOTICE}</p> : null}
          </div>
        );
      })}
      {error ?? saveError ? <p className={styles.notice} role="alert">{error ?? saveError}</p> : null}
      {preview ? <ImagePreviewDialog images={[preview]} initialIndex={0} onClose={() => setPreview(undefined)} /> : null}
    </section>
  );
}

function ArtifactThumbnail({ client, runId, artifact, onPreview }: { client: ApiClient; runId: string; artifact: RunArtifact; onPreview: (src?: string, aspectRatio?: number) => void }) {
  const host = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setSrc(undefined);
    setFailed(false);
    const load = async () => {
      try {
        const blob = await artifactPreviewBlob(client, runId, artifact, 'thumbnail');
        if (cancelled) { return; }
        if (!blob) { setFailed(true); return; }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch { if (!cancelled) { setFailed(true); } }
    };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); }
    }, { rootMargin: '240px' }) : undefined;
    if (observer && host.current) { observer.observe(host.current); }
    else { void load(); }
    return () => { cancelled = true; observer?.disconnect(); if (objectUrl) { URL.revokeObjectURL(objectUrl); } };
  }, [client, runId, artifact.id, artifact.size, artifact.mediaType, attempt]);
  return (
    <button ref={host} className={styles.preview} type="button" aria-label={`${failed ? 'Retry preview of' : 'Preview'} ${artifact.name}`}
      onClick={() => {
        if (failed) { setAttempt(value => value + 1); return; }
        const image = host.current?.querySelector('img');
        onPreview(src, image?.naturalHeight ? image.naturalWidth / image.naturalHeight : undefined);
      }}>
      {src && !failed ? <img src={src} alt={artifact.name} onError={() => setFailed(true)} /> : (
        <span className={styles.placeholder}>{failed ? 'Preview unavailable · Retry' : 'Loading preview…'}</span>
      )}
    </button>
  );
}
