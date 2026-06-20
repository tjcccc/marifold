import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Terminal dimensions, kept current across resizes. The inline layout uses
 * `rows` only to cap overlay (picker) height; Ink handles input/transcript
 * wrapping itself. */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}
