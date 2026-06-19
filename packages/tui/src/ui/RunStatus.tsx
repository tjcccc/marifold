import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ACCENT, DIM } from './theme.js';

/** Whimsical placeholders for the generic thinking phase, in the spirit of
 * Claude Code's activity words. A specific tool name takes precedence. */
const VERBS = [
  'Pondering', 'Drizzling', 'Percolating', 'Noodling', 'Simmering',
  'Conjuring', 'Tinkering', 'Brewing', 'Mulling', 'Whirring',
  'Marinating', 'Ruminating',
];

/**
 * Transient run line shown above the input while a task is active: a verb,
 * elapsed time, the think/effort hint, any queued steering, and the cancel
 * hint. It mounts only while running, so its elapsed clock resets per run.
 *
 * Token counts are intentionally omitted — they are not part of the
 * renderer-agnostic AgentEvent contract today.
 */
export function RunStatus({
  activity,
  think,
  steeringQueued,
}: {
  activity?: string;
  think: boolean;
  steeringQueued: number;
}): React.ReactElement {
  const [start] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const verb = labelFor(activity, start);
  const detail = [formatElapsed(Date.now() - start), think ? 'thinking' : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Box paddingX={1}>
      <Text>
        <Text color={ACCENT}>· {verb}…</Text>
        <Text color={DIM}> ({detail})</Text>
        {steeringQueued > 0 ? <Text color={DIM}> · {steeringQueued} steering queued</Text> : null}
        <Text color={DIM}> · esc to cancel</Text>
      </Text>
    </Box>
  );
}

function labelFor(activity: string | undefined, seed: number): string {
  if (activity && activity !== 'thinking' && activity !== 'working') {
    return activity.charAt(0).toUpperCase() + activity.slice(1);
  }
  return VERBS[Math.floor(seed / 1000) % VERBS.length];
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
