import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import styles from './ResizableSidebar.module.css';

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 200;
const STORAGE_KEY = 'marifold.sidebarWidth';
const KEYBOARD_STEP = 8;

export interface ResizableSidebarProps {
  children: ReactNode;
}

/** Persistent desktop primary-sidebar width with pointer and keyboard resizing. */
export function ResizableSidebar({ children }: ResizableSidebarProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [width, setWidth] = useState(loadSidebarWidth);
  const [dragging, setDragging] = useState(false);

  function maximumWidth(): number {
    const measuredWidth = frameRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    const workspaceWidth = measuredWidth > 0 ? measuredWidth : window.innerWidth;
    return Math.max(MIN_SIDEBAR_WIDTH, Math.floor(workspaceWidth * 0.4));
  }

  function updateWidth(next: number, persist: boolean): void {
    const clamped = Math.min(maximumWidth(), Math.max(MIN_SIDEBAR_WIDTH, Math.round(next)));
    setWidth(clamped);
    if (!persist) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
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
    if (!dragRef.current) return;
    updateWidth(dragRef.current.width + event.clientX - dragRef.current.x, false);
  }

  function finishResize(event: PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    updateWidth(frameRef.current?.getBoundingClientRect().width ?? width, true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = width - KEYBOARD_STEP;
    else if (event.key === 'ArrowRight') next = width + KEYBOARD_STEP;
    else if (event.key === 'Home') next = MIN_SIDEBAR_WIDTH;
    else if (event.key === 'End') next = maximumWidth();
    if (next === undefined) return;
    event.preventDefault();
    updateWidth(next, true);
  }

  return (
    <div ref={frameRef} className={styles.frame} style={{ width }}>
      <div className={styles.content}>{children}</div>
      <div
        className={`${styles.handle}${dragging ? ` ${styles.handleActive}` : ''}`}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
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

function loadSidebarWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= MIN_SIDEBAR_WIDTH) {
      const maximum = Math.max(MIN_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.4));
      return Math.min(maximum, stored);
    }
  } catch {
    // Fall through to the product default.
  }
  return DEFAULT_SIDEBAR_WIDTH;
}
