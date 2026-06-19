import React from 'react';
import { Box, Text } from 'ink';
import * as path from 'path';
import type { AppState } from '../core/appState.js';
import { DIM } from './theme.js';

/**
 * Persistent identity line pinned below the input: working-dir basename,
 * profile, mode, and provider/model on the left; the input-grammar hint on
 * the right. Run activity lives in the transient {@link RunStatus} line above
 * the input, so this line stays stable across a run.
 */
export function StatusLine({ state }: { state: AppState }): React.ReactElement {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text bold>{path.basename(state.cwd)}</Text>
        <Text color={DIM}> | </Text>
        <Text bold>{state.profile}</Text>
        <Text color={DIM}> · {state.mode} · {state.provider}/{state.model}</Text>
      </Text>
      <Text color={DIM}>$skill · /command</Text>
    </Box>
  );
}
