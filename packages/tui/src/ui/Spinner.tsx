import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Tiny braille spinner — no external dependency, advances on a timer. */
export function Spinner({ color }: { color?: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <Text color={color}>{FRAMES[frame]}</Text>;
}
