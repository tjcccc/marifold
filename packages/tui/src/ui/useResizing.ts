import { useEffect, useRef, useState } from 'react';
import { useStdout } from 'ink';

/**
 * True while the terminal is actively being resized, flipping back to false
 * after `quietMs` with no further resize events.
 *
 * Inline TUIs duplicate their input on resize because the terminal reflows the
 * scrollback above (scrolling the viewport), and Ink's "move up N lines and
 * erase" then targets the wrong rows — residue accumulates per resize tick. The
 * fix is to collapse the live region to a single stable line during the resize
 * burst: with nothing multi-line to mis-erase, the duplication can't build up,
 * and the full input is redrawn cleanly once the size settles. Users don't type
 * mid-resize, so the collapse is invisible in practice.
 */
export function useResizing(quietMs = 150): boolean {
  const { stdout } = useStdout();
  const [resizing, setResizing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setResizing(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setResizing(false), quietMs);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [stdout, quietMs]);
  return resizing;
}
