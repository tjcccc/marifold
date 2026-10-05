import { createContext, useContext, useEffect, useRef } from 'react';
import type { EventEmitter } from 'node:events';

export interface MouseEvent {
  x: number;
  y: number;
  button: number;
  action: 'press' | 'release' | 'move' | 'wheel';
  shift: boolean;
}

export const SelectionCopyContext = createContext<((text: string) => void) | undefined>(undefined);

export const MouseContext = createContext<EventEmitter | undefined>(undefined);

export function useMouse(handler: (event: MouseEvent) => void): boolean {
  const source = useContext(MouseContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!source) return;
    const listener = (event: MouseEvent) => latest.current(event);
    source.on('mouse', listener);
    return () => { source.off('mouse', listener); };
  }, [source]);
  return source !== undefined;
}
