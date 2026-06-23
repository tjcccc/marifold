import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ACCENT, DIM } from './theme.js';
import { padTo, truncate } from './text.js';

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

/** Arrow-key list: Enter selects, Esc cancels, Del removes (when onDelete set). */
export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
  onDelete,
  maxRows,
  emptyHint,
}: {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  onDelete?: (value: string) => void;
  maxRows?: number;
  /** Extra dim lines shown under "(none)" when the list is empty. */
  emptyHint?: string[];
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, Math.max(0, items.length - 1));
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Window items around the selection so a long list never overflows the frame
  // (reserve rows for border, title, and the footer hint).
  const cap = maxRows ? Math.max(1, maxRows - 5) : items.length;
  const start = Math.min(Math.max(0, clamped - Math.floor(cap / 2)), Math.max(0, items.length - cap));
  const windowed = items.slice(start, start + cap);
  const above = start;
  const below = Math.max(0, items.length - (start + cap));

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (items.length === 0) return;
    if (key.upArrow) setIndex(i => (i <= 0 ? items.length - 1 : i - 1));
    else if (key.downArrow) setIndex(i => (i >= items.length - 1 ? 0 : i + 1));
    else if (key.return) onSelect(items[clamped].value);
    else if (onDelete && (key.delete || key.backspace)) onDelete(items[clamped].value);
  });

  return (
    <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1}>
      <Text bold color={ACCENT}>{title}</Text>
      {items.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>(none)</Text>
          {emptyHint?.map((line, i) => <Text key={i} dimColor>{line}</Text>)}
        </Box>
      ) : (
        (() => {
          // Align hints into a column: pad each label to the widest (capped),
          // then clip the hint to the remaining inner width (terminal − border(2)
          // − padding(2)) so every row stays a single, non-wrapping line.
          const labelCol = Math.min(28, Math.max(...windowed.map(it => it.label.length)));
          const hintMax = columns - 4 /*border+padding*/ - 2 /*prefix*/ - labelCol - 2 /*gap*/ - 1;
          return windowed.map((item, i) => {
            const actual = start + i;
            const selected = actual === clamped;
            const prefix = selected ? '› ' : '  ';
            const label = padTo(truncate(item.label, labelCol), labelCol);
            const hint = item.hint ? truncate(item.hint, hintMax) : '';
            return (
              <Box key={item.value}>
                <Text color={selected ? ACCENT : undefined} bold={selected}>{prefix}{label}</Text>
                {hint ? <Text color={DIM}>{'  '}{hint}</Text> : null}
              </Box>
            );
          });
        })()
      )}
      {above > 0 || below > 0 ? (
        <Text dimColor>{above > 0 ? `↑ ${above} ` : ''}{below > 0 ? `↓ ${below}` : ''}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter select{onDelete ? ' · Del remove' : ''} · Esc cancel</Text>
      </Box>
    </Box>
  );
}
