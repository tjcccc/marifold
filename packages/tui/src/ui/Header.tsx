import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../core/appState.js';

export function Header({ state }: { state: AppState }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color="cyan" bold>marifold</Text>
        <Text>
          <Text color="magenta">{state.mode}</Text>
          <Text dimColor> · </Text>
          <Text color="green">{state.profile}</Text>
          <Text dimColor> · </Text>
          <Text>{state.provider}/{state.model}</Text>
        </Text>
      </Box>
      <Text dimColor>{state.cwd}</Text>
    </Box>
  );
}
