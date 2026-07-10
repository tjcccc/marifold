import { useEffect, useRef, useState } from 'react';
import styles from './AvatarCropper.module.css';

const VIEWPORT = 280; // on-screen crop square (px)
const OUTPUT = 512; // exported avatar size (px)

export interface AvatarCropperProps {
  file: File;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}

/**
 * Square avatar crop + zoom (Apple/social style). The user positions and zooms
 * within a circular preview; on save the visible square is drawn to a 512²
 * canvas and exported as a **lossless PNG** — so a large input is downscaled on
 * save while the stored file stays small.
 */
export function AvatarCropper({ file, busy, onCancel, onConfirm }: AvatarCropperProps) {
  const [src, setSrc] = useState<string>();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number }>();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Base "cover" scale so the image always fills the viewport; zoom multiplies it.
  const cover = nat ? Math.max(VIEWPORT / nat.w, VIEWPORT / nat.h) : 1;
  const scale = cover * zoom;
  const dw = nat ? nat.w * scale : VIEWPORT;
  const dh = nat ? nat.h * scale : VIEWPORT;

  function clamp(o: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.min(0, Math.max(VIEWPORT - dw, o.x)),
      y: Math.min(0, Math.max(VIEWPORT - dh, o.y)),
    };
  }

  // Keep the image covering the viewport when zoom or the loaded image changes.
  useEffect(() => {
    setOffset(o => clamp(o));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, nat]);

  function onPointerDown(event: React.PointerEvent): void {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(event: React.PointerEvent): void {
    if (!drag.current) return;
    setOffset(clamp({
      x: drag.current.ox + (event.clientX - drag.current.x),
      y: drag.current.oy + (event.clientY - drag.current.y),
    }));
  }
  function onPointerUp(): void {
    drag.current = null;
  }

  function save(): void {
    const img = imgRef.current;
    if (!img || !nat) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    // The original-image region visible in the viewport square → the 512² output.
    const source = VIEWPORT / scale;
    ctx.drawImage(img, -offset.x / scale, -offset.y / scale, source, source, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob(blob => {
      if (blob) onConfirm(new File([blob], 'avatar.png', { type: 'image/png' }));
    }, 'image/png');
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Adjust avatar">
      <div className={styles.modal}>
        <div className={styles.title}>Adjust avatar</div>
        <div className={styles.hint}>Drag to reposition · slide to zoom</div>
        <div
          className={styles.viewport}
          style={{ width: VIEWPORT, height: VIEWPORT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {src ? (
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              className={styles.image}
              style={{ width: dw, height: dh, transform: `translate(${offset.x}px, ${offset.y}px)` }}
              onLoad={event => setNat({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            />
          ) : null}
          <div className={styles.mask} aria-hidden />
        </div>
        <div className={styles.zoomRow}>
          <span aria-hidden>−</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={event => setZoom(Number(event.target.value))}
            className={styles.zoom}
            aria-label="Zoom"
          />
          <span aria-hidden>+</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={styles.save} onClick={save} disabled={busy || !nat}>
            Save avatar
          </button>
        </div>
      </div>
    </div>
  );
}
