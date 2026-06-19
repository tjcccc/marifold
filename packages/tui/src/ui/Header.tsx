import React from 'react';
import { Box, Text } from 'ink';
import { marifoldHome } from '@marifold/core';
import type { AppState } from '../core/appState.js';
import { tildify } from '../core/displayPaths.js';
import { ACCENT, DIM } from './theme.js';

/**
 * Startup banner. Printed once into the terminal scrollback (above the live
 * transcript), so it scrolls away as the conversation grows while the input
 * and status line stay pinned at the bottom. Three rows, each pairing a
 * left-aligned identity segment with a right-aligned hint.
 */
export function Header({ state }: { state: AppState }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={ACCENT} width="100%" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>marifold</Text>
          <Text color={DIM}>  v{state.version}</Text>
        </Text>
        {state.latestVersion ? (
          <Text color={DIM}>new version (v{state.latestVersion}) available</Text>
        ) : null}
      </Box>
      <Box justifyContent="space-between">
        <Text bold>{tildify(state.cwd)}</Text>
        <Text color={DIM}>{tildify(marifoldHome())}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{state.profile}</Text>
          <Text color={DIM}> · {state.mode} · {state.provider}/{state.model}</Text>
        </Text>
        <Text color={DIM}>/help for usage</Text>
      </Box>
    </Box>
  );
}
