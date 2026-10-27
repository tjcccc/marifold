import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import styles from './ResizableSidebar.module.css';

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 200;
const DEFAULT_STORAGE_KEY = 'marifold.sidebarWidth';
const KEYBOARD_STEP = 8;

export interface ResizableSidebarProps {
  children: ReactNode;
  storageKey?: string;
  defaultWidth?: number;
  ariaLabel?: string;
  /** The edge the sidebar sits on; its handle is on the opposite side. */
  side?: 'left' | 'right';
  minWidth?: number;
}

/** Persistent desktop sidebar width with pointer and keyboard resizing. */
export function ResizableSidebar({
  children,
  storageKey = DEFAULT_STORAGE_KEY,
  defaultWidth = DEFAULT_SIDEBAR_WIDTH,
  ariaLabel = 'Resize sidebar',
  side = 'left',
  minWidth = MIN_SIDEBAR_WIDTH,
}: ResizableSidebarProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [width, setWidth] = useState(() => loadSidebarWidth(storageKey, defaultWidth, minWidth));
  // A right-hand sidebar grows as its left-edge handle moves left.
  const direction = side === 'right' ? -1 : 1;
  const [dragging, setDragging] = useState(false);

  function maximumWidth(): number {
    const measuredWidth = frameRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    const workspaceWidth = measuredWidth > 0 ? measuredWidth : window.innerWidth;
    return Math.max(minWidth, Math.floor(workspaceWidth * 0.4));
  }

  function updateWidth(next: number, persist: boolean): void {
    const clamped = Math.min(maximumWidth(), Math.max(minWidth, Math.round(next)));
    setWidth(clamped);
    if (!persist) { return; }
    try {
      window.localStorage.setItem(storageKey, String(clamped));
    } catch {
      // The in-page width still works when storage is unavailable.
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    dragRef.current = { x: event.clientX, width: frameRef.current?.getBoundingClientRect().width ?? width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) { return; }
    updateWidth(dragRef.current.width + direction * (event.clientX - dragRef.current.x), false);
  }

  function finishResize(event: PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) { return; }
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    updateWidth(frameRef.current?.getBoundingClientRect().width ?? width, true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    let next: number | undefined;
    if (event.key === 'ArrowLeft') { next = width - direction * KEYBOARD_STEP; }
    else if (event.key === 'ArrowRight') { next = width + direction * KEYBOARD_STEP; }
    else if (event.key === 'Home') { next = minWidth; }
    else if (event.key === 'End') { next = maximumWidth(); }
    if (next === undefined) { return; }
    event.preventDefault();
    updateWidth(next, true);
  }

  return (
    <div ref={frameRef} className={side === 'right' ? styles.frameRight : styles.frame} style={{ width, minWidth }}>
      <div className={styles.content}>{children}</div>
      <div
        className={`${side === 'right' ? styles.handleRight : styles.handle}${dragging ? ` ${styles.handleActive}` : ''}`}
        role="separator"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maximumWidth()}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function loadSidebarWidth(storageKey: string, defaultWidth: number, minWidth: number): number {
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored >= minWidth) {
      const maximum = Math.max(minWidth, Math.floor(window.innerWidth * 0.4));
      return Math.min(maximum, stored);
    }
  } catch {
    // Fall through to the product default.
  }
  return defaultWidth;
}
