import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

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
}: {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  onDelete?: (value: string) => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, Math.max(0, items.length - 1));

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
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {items.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        items.map((item, i) => (
          <Text key={item.value} color={i === clamped ? 'green' : undefined} inverse={i === clamped}>
            {i === clamped ? '› ' : '  '}{item.label}{item.hint ? `  ${item.hint}` : ''}
          </Text>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter select{onDelete ? ' · Del remove' : ''} · Esc cancel</Text>
      </Box>
    </Box>
  );
}
