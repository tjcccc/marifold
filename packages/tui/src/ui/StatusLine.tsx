import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../core/appState.js';
import { Spinner } from './Spinner.js';

/** Bottom status line: run activity, queued-steering hint, and cancel hint. */
export function StatusLine({
  state,
  steeringQueued,
}: {
  state: AppState;
  steeringQueued: number;
}): React.ReactElement {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        {state.running ? (
          <Text color="yellow"><Spinner color="yellow" /> {state.activity ?? 'working'}…</Text>
        ) : (
          <Text dimColor>ready</Text>
        )}
        {steeringQueued > 0 ? <Text color="blue"> · {steeringQueued} steering queued</Text> : null}
      </Text>
      <Text dimColor>
        {state.running ? 'esc/ctrl-c cancel' : '/help · $skill · /chat /agent'}
      </Text>
    </Box>
  );
}
