import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * Single-line-with-continuation input with cursor editing, history, readline
 * shortcuts, and Tab completion for `/commands` and `$skills`.
 *
 * - Backspace handles the macOS DEL (0x7f) the terminal sends, and control
 *   characters are filtered so pastes/escape runs never corrupt the buffer.
 * - A line ending in `\` continues onto a new line instead of submitting, so
 *   multi-line prompts are possible without a 2D editor (Up/Down stay free for
 *   history).
 * - Ctrl+A/E jump to start/end, Ctrl+U deletes to start, Ctrl+W deletes a word.
 * - Esc and Ctrl+C forward to onInterrupt so the App can cancel a run.
 *
 * Only mounted when no modal/overlay is active, so its useInput never competes.
 */
export function InputBox({
  onSubmit,
  onInterrupt,
  placeholder,
  history,
  commandNames,
  skillNames,
}: {
  onSubmit: (value: string) => void;
  onInterrupt: (reason: 'ctrl-c' | 'escape') => void;
  placeholder?: string;
  history: string[];
  commandNames: string[];
  skillNames: string[];
}): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [histDraft, setHistDraft] = useState('');

  const set = (next: string, caret = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(caret, next.length)));
    setHistIndex(null);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onInterrupt('ctrl-c');
    if (key.escape) return onInterrupt('escape');

    if (key.tab) {
      complete();
      return;
    }
    if (key.return) {
      if (value.endsWith('\\')) {
        set(`${value.slice(0, -1)}\n`);
        return;
      }
      const submitted = value;
      setValue('');
      setCursor(0);
      setHistIndex(null);
      onSubmit(submitted);
      return;
    }

    if (key.ctrl && input === 'a') return setCursor(0);
    if (key.ctrl && input === 'e') return setCursor(value.length);
    if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const start = wordStart(value, cursor);
      set(value.slice(0, start) + value.slice(cursor), start);
      return;
    }

    if (key.leftArrow) return setCursor(c => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor(c => Math.min(value.length, c + 1));
    if (key.upArrow) return historyPrev();
    if (key.downArrow) return historyNext();

    if (key.backspace || key.delete || input === '\x7f' || input === '\b') {
      if (cursor === 0) return;
      set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }

    if (key.ctrl || key.meta || !input) return;
    const printable = [...input].filter(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }).join('');
    if (!printable) return;
    set(value.slice(0, cursor) + printable + value.slice(cursor), cursor + printable.length);
  });

  function historyPrev(): void {
    if (history.length === 0) return;
    const index = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1);
    if (histIndex === null) setHistDraft(value);
    setValue(history[index]);
    setCursor(history[index].length);
    setHistIndex(index);
  }

  function historyNext(): void {
    if (histIndex === null) return;
    if (histIndex < history.length - 1) {
      const index = histIndex + 1;
      setValue(history[index]);
      setCursor(history[index].length);
      setHistIndex(index);
    } else {
      setValue(histDraft);
      setCursor(histDraft.length);
      setHistIndex(null);
    }
  }

  function complete(): void {
    if (value.includes(' ') || value.includes('\n')) return; // only the head token
    const sigil = value[0];
    if (sigil !== '/' && sigil !== '$') return;
    const prefix = value.slice(1);
    const pool = sigil === '/' ? commandNames : skillNames;
    const matches = pool.filter(name => name.startsWith(prefix));
    if (matches.length === 0) return;
    if (matches.length === 1) {
      set(`${sigil}${matches[0]} `);
      return;
    }
    const lcp = longestCommonPrefix(matches);
    if (lcp.length > prefix.length) set(`${sigil}${lcp}`);
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="green">{'❯ '}</Text>
      {value.length === 0 && placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        renderWithCursor(value, cursor)
      )}
    </Box>
  );
}

function renderWithCursor(value: string, cursor: number): React.ReactElement {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at === '\n' ? ' ' : at}</Text>
      {after}
    </Text>
  );
}

function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && value[i - 1] === ' ') i -= 1;
  while (i > 0 && value[i - 1] !== ' ') i -= 1;
  return i;
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}
