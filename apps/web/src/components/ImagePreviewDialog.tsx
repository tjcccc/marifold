import { useEffect, useRef, useState } from 'react';
import styles from './ImagePreviewDialog.module.css';

export interface PreviewImage {
  src?: string;
  sourcePath?: string;
  alt: string;
  aspectRatio?: number;
  loadSrc?: () => Promise<string>;
  loadBlob?: () => Promise<Blob>;
  download?: () => Promise<void>;
}

export interface ImagePreviewDialogProps {
  images: PreviewImage[];
  initialIndex: number;
  loadImage?: (path: string) => Promise<Blob | undefined>;
  onClose: () => void;
}

/** Full-window image preview shared by pending attachments and transcript images. */
export function ImagePreviewDialog({ images, initialIndex, loadImage, onClose }: ImagePreviewDialogProps) {
  const [index, setIndex] = useState(() => clampIndex(initialIndex, images.length));
  const [resolvedSrc, setResolvedSrc] = useState<string>();
  const [fitRatio, setFitRatio] = useState<number>();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const multiple = images.length > 1;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      else if (event.key === 'ArrowLeft' && multiple) {
        event.preventDefault();
        setIndex(current => wrapIndex(current - 1, images.length));
      } else if (event.key === 'ArrowRight' && multiple) {
        event.preventDefault();
        setIndex(current => wrapIndex(current + 1, images.length));
      } else if (event.key === 'Tab') {
        const controls = [
          closeRef.current,
          downloadRef.current,
          ...document.querySelectorAll<HTMLButtonElement>(`.${styles.arrow}, .${styles.zoom}`),
        ].filter((item): item is HTMLButtonElement => Boolean(item) && !item!.disabled);
        if (controls.length === 0) return;
        const current = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (current - 1 + controls.length) % controls.length
          : (current + 1) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [images.length, multiple]);

  useEffect(() => {
    setIndex(current => clampIndex(current, images.length));
  }, [images.length]);

  const current = images[index];
  useEffect(() => {
    setResolvedSrc(current?.src);
    setFitRatio(current?.aspectRatio);
    setLoadingPreview(Boolean(current?.loadSrc || current?.loadBlob));
    setError(undefined);
    setZoomed(false);
    if (current?.loadSrc || current?.loadBlob) {
      let cancelled = false;
      const image = new Image();
      let objectUrl: string | undefined;
      const source = current.loadBlob ? current.loadBlob() : current.loadSrc!();
      source.then(async value => {
        if (cancelled) return;
        const src = typeof value === 'string' ? value : (objectUrl = URL.createObjectURL(value));
        image.src = src;
        await image.decode();
        if (cancelled) return;
        setFitRatio(current.aspectRatio ?? image.naturalWidth / image.naturalHeight);
        setResolvedSrc(src);
        setLoadingPreview(false);
      }).catch(error => {
        if (!cancelled) {
          setLoadingPreview(false);
          setError(error instanceof Error ? error.message : 'Could not load the image.');
        }
      });
      return () => { cancelled = true; image.src = ''; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    if (current?.src || !current?.sourcePath || !loadImage) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    loadImage(current.sourcePath).then(blob => {
      if (cancelled) return;
      if (!blob) { setError('This image is no longer available.'); return; }
      objectUrl = URL.createObjectURL(blob);
      setResolvedSrc(objectUrl);
    }).catch(() => { if (!cancelled) setError('Could not load the image. Close the preview and try again.'); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current?.sourcePath, current?.src, current?.aspectRatio, current?.loadSrc, current?.loadBlob, loadImage]);
  if (!current) return null;

  function move(delta: number): void {
    setIndex(currentIndex => wrapIndex(currentIndex + delta, images.length));
  }

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${current.alt} preview`}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        className={styles.close}
        type="button"
        aria-label="Close image preview"
        onClick={onClose}
      >
        ×
      </button>
      {multiple ? (
        <button
          className={`${styles.arrow} ${styles.previous}`}
          type="button"
          aria-label="Previous image"
          onClick={event => {
            event.stopPropagation();
            move(-1);
          }}
        >
          <Chevron direction="previous" />
        </button>
      ) : null}
      <div className={styles.stage} onClick={event => event.stopPropagation()}>
        <div className={zoomed ? styles.zoomed : undefined}>
          {resolvedSrc ? (
            <button type="button" className={`${styles.zoom} ${!zoomed && fitRatio ? styles.fitted : ''}`}
              style={!zoomed && fitRatio ? { width: `min(var(--preview-width), calc(var(--preview-height) * ${fitRatio}))`, aspectRatio: fitRatio } : undefined}
              disabled={loadingPreview} aria-busy={loadingPreview} aria-label={zoomed ? 'Fit image to window' : 'View image at full size'} onClick={() => setZoomed(value => !value)}>
              <img className={styles.image} src={resolvedSrc} alt={current.alt} onError={() => { setResolvedSrc(undefined); setError('Could not load the image. Close the preview and try again.'); }} />
            </button>
          ) : !error ? (
            <div className={styles.loading} role="status">Loading image…</div>
          ) : null}
        </div>
        {current.download ? <button ref={downloadRef} className={styles.download} type="button" disabled={downloading}
          aria-label={downloading ? 'Starting download…' : 'Download image'}
          title="Download image" aria-busy={downloading}
          onClick={async event => {
            event.stopPropagation();
            setDownloading(true);
            try { await current.download!(); }
            catch (error) { setError(error instanceof Error ? error.message : 'Download failed.'); }
            finally { setDownloading(false); }
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button> : null}
        {error ? <div className={styles.loading} role="alert">{error}</div> : null}
        {multiple ? <div className={styles.counter}>{index + 1} / {images.length}</div> : null}
      </div>
      {multiple ? (
        <button
          className={`${styles.arrow} ${styles.next}`}
          type="button"
          aria-label="Next image"
          onClick={event => {
            event.stopPropagation();
            move(1);
          }}
        >
          <Chevron direction="next" />
        </button>
      ) : null}
    </div>
  );
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function wrapIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index + length) % length;
}

function Chevron({ direction }: { direction: 'previous' | 'next' }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden focusable="false">
      <path
        d={direction === 'previous' ? 'm13.5 4.5-6.5 6.5 6.5 6.5' : 'm8.5 4.5 6.5 6.5-6.5 6.5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
