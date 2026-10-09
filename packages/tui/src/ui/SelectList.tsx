import type React from 'react';
import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import stringWidth from 'string-width';
import { isModifiedReturn } from './InputBox.js';
import { ACCENT, DIM } from './theme.js';
import { padTo, truncate } from './text.js';

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
  /** Short status shown before the label in the warning color, e.g. `in use`. */
  badge?: string;
}

/** A second action on the highlighted item, bound to Shift+Enter (or another
 * modified Enter) and to `key` for terminals that send Shift+Enter as Enter. */
export interface SelectAlternate {
  label: string;
  key: string;
  onSelect: (value: string) => void;
}

/** Arrow-key list: Enter selects, Esc cancels, Del removes (when onDelete set). */
export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
  onDelete,
  alternate,
  message,
  maxRows,
  emptyHint,
}: {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  onDelete?: (value: string) => void;
  alternate?: SelectAlternate;
  /** A warning shown above the key hints, e.g. why Enter did nothing. */
  message?: string;
  maxRows?: number;
  /** Extra dim lines shown under "(none)" when the list is empty. */
  emptyHint?: string[];
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, Math.max(0, items.length - 1));
  const { columns } = useWindowSize();

  // Window items around the selection so a long list never overflows the frame
  // (reserve rows for border, title, and the footer hint). Also cap to a fixed
  // comfortable maximum so a long list still windows (with a scroll counter) on
  // very tall terminals, where `maxRows - 5` would otherwise exceed the list.
  const MAX_VISIBLE = 12;
  const cap = Math.min(maxRows ? Math.max(1, maxRows - 5) : items.length, MAX_VISIBLE);
  const start = Math.min(Math.max(0, clamped - Math.floor(cap / 2)), Math.max(0, items.length - cap));
  const windowed = items.slice(start, start + cap);
  const above = start;
  const below = Math.max(0, items.length - (start + cap));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (items.length === 0) { return; }
    if (alternate && ((key.return && (key.shift || key.meta || key.ctrl)) || isModifiedReturn(input) || input.toLowerCase() === alternate.key)) {
      alternate.onSelect(items[clamped].value);
      return;
    }
    if (key.upArrow) { setIndex(i => (i <= 0 ? items.length - 1 : i - 1)); }
    else if (key.downArrow) { setIndex(i => (i >= items.length - 1 ? 0 : i + 1)); }
    else if (key.return) { onSelect(items[clamped].value); }
    else if (onDelete && (key.delete || key.backspace)) { onDelete(items[clamped].value); }
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
          const badgeWidth = (item: SelectItem) => item.badge ? stringWidth(item.badge) + 3 /*[] and space*/ : 0;
          const labelCol = Math.min(28, Math.max(...windowed.map(it => badgeWidth(it) + stringWidth(it.label))));
          const hintMax = columns - 4 /*border+padding*/ - 2 /*prefix*/ - labelCol - 2 /*gap*/ - 1;
          return windowed.map((item, i) => {
            const actual = start + i;
            const selected = actual === clamped;
            const prefix = selected ? '› ' : '  ';
            const badge = item.badge ? `[${item.badge}] ` : '';
            const labelWidth = Math.max(0, labelCol - badgeWidth(item));
            const label = padTo(truncate(item.label, labelWidth), labelWidth);
            const hint = item.hint ? truncate(item.hint, hintMax) : '';
            return (
              <Box key={item.value}>
                <Text color={selected ? ACCENT : undefined} bold={selected}>{prefix}{badge ? <Text color="yellow">{badge}</Text> : null}{label}</Text>
                {hint ? <Text color={DIM}>{'  '}{hint}</Text> : null}
              </Box>
            );
          });
        })()
      )}
      {above > 0 || below > 0 ? (
        <Text dimColor>{above > 0 ? `↑ ${above} ` : ''}{below > 0 ? `↓ ${below}` : ''}</Text>
      ) : null}
      {message ? <Box marginTop={1}><Text color="yellow">{message}</Text></Box> : null}
      <Box marginTop={message ? 0 : 1}>
        <Text dimColor>↑/↓ move · Enter select{alternate ? ` · Shift+Enter or ${alternate.key.toUpperCase()} ${alternate.label}` : ''}{onDelete ? ' · Del remove' : ''} · Esc cancel</Text>
      </Box>
    </Box>
  );
}
