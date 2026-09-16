import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { RunArtifact } from '../../api/types';
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog';
import type { PreviewImage } from '../../components/ImagePreviewDialog';
import { ARTIFACT_UNAVAILABLE_NOTICE, downloadRunArtifact, isImageArtifact } from '../../lib/runArtifacts';
import { useArtifactDownloads } from './useArtifactDownloads';
import styles from './RunArtifacts.module.css';
import { artifactPreviewBlob } from '../../lib/artifactPreviewCache';

/** Deliverables belong to the answer and remain visible independently of logs. */
export function RunArtifacts({ client, runId, artifacts }: { client?: ApiClient; runId: string; artifacts: RunArtifact[] }) {
  const { unavailable, downloading, error, download } = useArtifactDownloads(client, runId, artifacts);
  const [preview, setPreview] = useState<PreviewImage>();
  useEffect(() => { setPreview(undefined); }, [client, runId]);
  if (!artifacts.length) return null;
  return (
    <section className={styles.files} aria-label="Generated files">
      {artifacts.map(artifact => {
        const missing = unavailable.has(artifact.id);
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
              disabled={!client || missing || downloading === artifact.id} onClick={() => void download(artifact)}>
              <span aria-hidden>{isImageArtifact(artifact) ? '▧' : '▤'}</span>
              <span className={styles.label}>
                <span className={styles.name}>{name}</span>
                <span className={styles.detail}>{missing ? 'Unavailable' : downloading === artifact.id ? 'Starting download…' : 'Download'} · {formatBytes(artifact.size)}</span>
              </span>
              <span aria-hidden>↓</span>
            </button>
            {missing ? <p className={styles.notice} role="status">{ARTIFACT_UNAVAILABLE_NOTICE}</p> : null}
          </div>
        );
      })}
      {error ? <p className={styles.notice} role="alert">{error}</p> : null}
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
        if (cancelled) return;
        if (!blob) { setFailed(true); return; }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch { if (!cancelled) setFailed(true); }
    };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); }
    }, { rootMargin: '240px' }) : undefined;
    if (observer && host.current) observer.observe(host.current);
    else void load();
    return () => { cancelled = true; observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
