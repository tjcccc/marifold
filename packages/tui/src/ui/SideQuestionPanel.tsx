import type React from 'react';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { copyToClipboard } from './appHelpers.js';
import { wrapToVisualLines } from './inputLayout.js';
import { Spinner } from './Spinner.js';
import { ACCENT, COMMAND, DIM } from './theme.js';
import { useTerminalSize } from './useTerminalSize.js';
import type { SideQuestionView } from './useSideQuestion.js';

/** The `/btw` answer, below the run line in place of the composer. It owns
 * ↑/↓ (scroll), c (copy), and Esc (close) until it closes. */
export function SideQuestionPanel({ view, maxRows, onClose }: {
  view: SideQuestionView;
  maxRows: number;
  onClose: () => void;
}): React.ReactElement {
  const { columns } = useTerminalSize();
  const [offset, setOffset] = useState(0);
  const [copied, setCopied] = useState(false);
  const lines = view.answer === undefined ? [] : wrapToVisualLines(view.answer, Math.max(10, columns - 6)).map(line => line.text);
  const visible = Math.max(1, maxRows - 4);
  const maxOffset = Math.max(0, lines.length - visible);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { onClose(); return; }
    if (key.upArrow) { setOffset(current => Math.max(0, current - 1)); }
    if (key.downArrow) { setOffset(current => Math.min(maxOffset, current + 1)); }
    if (input === 'c' && view.answer !== undefined) {
      copyToClipboard(view.answer).then(() => setCopied(true), () => undefined);
    }
  });

  const hints = [
    ...(maxOffset > 0 ? ['↑/↓ to scroll'] : []),
    ...(view.answer !== undefined ? [copied ? 'Copied' : 'c to copy'] : []),
    'Esc to close',
  ];
  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderColor={ACCENT} paddingX={1}>
      <Text><Text color={COMMAND}>/btw</Text> {view.question}</Text>
      <Box flexDirection="column" paddingLeft={2} marginY={1}>
        {view.error !== undefined ? <Text color="red">{view.error}</Text>
          : view.answer === undefined ? <Text><Spinner color={ACCENT} /> <Text color={DIM}>Answering…</Text></Text>
          : lines.slice(offset, offset + visible).map((line, index) => <Text key={offset + index}>{line || ' '}</Text>)}
      </Box>
      <Text color={DIM}>{hints.join(' · ')}</Text>
    </Box>
  );
}
