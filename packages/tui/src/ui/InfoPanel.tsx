import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT } from './theme.js';

/** Read-only panel (help, permissions). Any key or Esc closes it. When
 * `maxRows` is set (fullscreen layout), content is capped to fit and the
 * remainder is summarized so the panel never overflows the frame. */
export function InfoPanel({
  title,
  lines,
  onClose,
  maxRows,
}: {
  title: string;
  lines: string[];
  onClose: () => void;
  maxRows?: number;
}): React.ReactElement {
  useInput(() => onClose());
  // Reserve rows for the border (2), title (1), close hint (1), and the
  // overflow summary (1) before deciding how many lines fit.
  const cap = maxRows ? Math.max(1, maxRows - 5) : lines.length;
  const shown = lines.slice(0, cap);
  const overflow = lines.length - shown.length;
  return (
    <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1}>
      <Text bold color={ACCENT}>{title}</Text>
      {shown.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {overflow > 0 ? <Text dimColor>… {overflow} more</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>(any key to close)</Text>
      </Box>
    </Box>
  );
}
