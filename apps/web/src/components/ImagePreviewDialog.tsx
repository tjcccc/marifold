import { useEffect, useState } from 'react';
import styles from './ImagePreviewDialog.module.css';

export interface PreviewImage {
  src: string;
  alt: string;
}

export interface ImagePreviewDialogProps {
  images: PreviewImage[];
  initialIndex: number;
  onClose: () => void;
}

/** Full-window image preview shared by pending attachments and transcript images. */
export function ImagePreviewDialog({ images, initialIndex, onClose }: ImagePreviewDialogProps) {
  const [index, setIndex] = useState(() => clampIndex(initialIndex, images.length));
  const multiple = images.length > 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && multiple) {
        event.preventDefault();
        setIndex(current => wrapIndex(current - 1, images.length));
      } else if (event.key === 'ArrowRight' && multiple) {
        event.preventDefault();
        setIndex(current => wrapIndex(current + 1, images.length));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [images.length, multiple, onClose]);

  useEffect(() => {
    setIndex(current => clampIndex(current, images.length));
  }, [images.length]);

  const current = images[index];
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
        className={styles.close}
        type="button"
        aria-label="Close image preview"
        onClick={onClose}
        autoFocus
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
        <img className={styles.image} src={current.src} alt={current.alt} />
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
