import { useWindowSize } from 'ink';

/** Terminal dimensions supplied by Ink, updated across resizes. */
export function useTerminalSize(): { columns: number; rows: number } {
  return useWindowSize();
}
