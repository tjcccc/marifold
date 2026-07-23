import { useEffect, useRef, useState } from 'react';
import styles from './ImagePreviewDialog.module.css';

export interface PreviewImage {
  src?: string;
  sourcePath?: string;
  alt: string;
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
          ...document.querySelectorAll<HTMLButtonElement>(`.${styles.arrow}`),
        ].filter((item): item is HTMLButtonElement => Boolean(item));
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
    if (current?.src || !current?.sourcePath || !loadImage) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    loadImage(current.sourcePath).then(blob => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setResolvedSrc(objectUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current?.sourcePath, current?.src, loadImage]);
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
        {resolvedSrc ? (
          <img className={styles.image} src={resolvedSrc} alt={current.alt} />
        ) : (
          <div className={styles.loading} role="status">Loading image…</div>
        )}
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
