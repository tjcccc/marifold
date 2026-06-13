import React from 'react';
import { Box, Text, useInput } from 'ink';

/** Read-only panel (help, permissions). Any key or Esc closes it. */
export function InfoPanel({
  title,
  lines,
  onClose,
}: {
  title: string;
  lines: string[];
  onClose: () => void;
}): React.ReactElement {
  useInput(() => onClose());
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>(any key to close)</Text>
      </Box>
    </Box>
  );
}
