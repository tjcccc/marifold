import { inputTokens } from '../core/inputTokens.js';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize, measureElement, type DOMElement } from 'ink';
import * as fs from 'fs';
import * as path from 'path';
import { expandHome } from '@marifold/core';
import { ACCENT, ATTACHMENT, COMMAND, DIM, SKILL } from './theme.js';
import { copyTerminalSelection } from './appHelpers.js';
import { padTo, truncate } from './text.js';
import { SelectionCopyContext, useMouse } from './Mouse.js';
import { graphemes, previousBoundary, nextBoundary, offsetAtColumn, wrapToVisualLines, locateVisualCursor, inputWindowStart, type VisualLine } from './inputLayout.js';

import type { InputHistoryEntry, PromptImage } from '../core/promptHistory.js';
export type { InputHistoryEntry } from '../core/promptHistory.js';

const PROMPT = '> ';
const CONT = '  '; // continuation-line indent, aligned past the prompt
const RULE = '─'; // input separator (plain text, not an Ink border — see render)
const MENU_LIMIT = 8;
// Cap the input's rendered height. A tall, changing input near the bottom of
// the inline layout makes Ink's frame exceed the viewport, and on shrink (e.g.
// deleting multi-line text) it can't erase the off-screen rows — leaving
// duplicated borders. Windowing the input to a few visual lines keeps the live
// frame small so Ink always clears it cleanly.
const MAX_INPUT_ROWS = 8;
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_TOKEN = /\[image #\d+\]/g;

// xterm modifyOtherKeys (ESC[27;<mod>;13~) and CSI-u (ESC[13;<mod>u) encodings
// for a modified Return (keycode 13), e.g. Ctrl+Enter. Ink leaves the raw
// modifyOtherKeys form unparsed, so we match it ourselves. (Two simple patterns
// — a single alternation literal here is mis-transformed by the bundler.)
const MOD_RETURN_XTERM = /\[27;\d+;13~/;
const MOD_RETURN_CSIU = /\[13;\d+u/;

function isModifiedReturn(input: string): boolean {
  return MOD_RETURN_XTERM.test(input) || MOD_RETURN_CSIU.test(input);
}

export interface CompletionItem {
  name: string;
  hint?: string;
}

/**
 * Multi-line input with a block cursor, history, readline shortcuts,
 * a live completion menu for `/commands` and `$skills`, and image-drop tokens.
 *
 * - Typing `/` or `$` opens a menu of matching commands/skills with their
 *   descriptions: ↑/↓ move, Tab/Enter accept, Esc dismisses.
 * - Dropping an image path inserts a green `[image #n]` token (indices reset
 *   each submitted message) and attaches the file to the next message.
 * - Ctrl+J, Ctrl+Enter, Shift+Enter, and Option/Alt+Enter insert a newline; a
 *   trailing `\` on Enter also continues. Plain Enter submits.
 * - Ctrl+A/Home & Ctrl+E/End jump to start/end, Ctrl+U deletes to start, Ctrl+K
 *   deletes to end, Ctrl+W deletes a word.
 * - Option/Alt+Left/Right (or Alt+B/F) move by word; Option/Alt+Backspace
 *   deletes the previous word. Ctrl+Left/Right also move by word.
 * - Esc and Ctrl+C forward to onInterrupt so the App can cancel a run.
 */
export function InputBox({
  onSubmit,
  onInterrupt,
  placeholder,
  history,
  commands,
  skills,
  resizing = false,
}: {
  onSubmit: (value: string, images: PromptImage[]) => void;
  onInterrupt: (reason: 'ctrl-c' | 'escape') => void;
  placeholder?: string;
  history: InputHistoryEntry[];
  commands: CompletionItem[];
  skills: CompletionItem[];
  /** While the terminal is resizing, collapse to a single line and ignore
   * typing so Ink's erase math can't desync and duplicate the input box. */
  resizing?: boolean;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);
  const setCursor = (next: number | ((current: number) => number)) => {
    cursorRef.current = typeof next === 'function' ? next(cursorRef.current) : next;
    setCursorState(cursorRef.current);
  };
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [histDraft, setHistDraft] = useState({ text: '', images: [] as PromptImage[] });
  const [images, setImages] = useState<PromptImage[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(true);

  const { columns, rows } = useWindowSize();
  const inputRef = useRef<DOMElement>(null);
  const copySelection = useContext(SelectionCopyContext);
  const [selection, setSelection] = useState<{ anchor: number; focus: number }>();
  const drag = useRef<{ anchor: number; focus: number; text: string; visual: VisualLine[]; start: number } | undefined>(undefined);
  const mouseEnabled = useMouse(event => {
    if (event.button !== 0 || event.action === 'wheel' || resizing || !inputRef.current) return;
    const bounds = measureElement(inputRef.current);
    const inside = event.y >= bounds.y && event.y < bounds.y + bounds.height && event.x >= bounds.x && event.x < bounds.x + bounds.width;
    if (event.action === 'press') {
      if (!inside) return;
      const visual = wrapToVisualLines(value, Math.max(1, columns - PROMPT.length - 1));
      const caret = locateVisualCursor(visual, cursorRef.current);
      const start = inputWindowStart(visual.length, caret.line, maxInputRows);
      const line = visual[start + event.y - bounds.y];
      if (!line) return;
      const anchor = line.start + offsetAtColumn(line.text, Math.max(0, event.x - bounds.x - PROMPT.length));
      drag.current = { anchor, focus: anchor, text: value, visual, start };
      setSelection(undefined);
      setCursor(anchor);
      return;
    }
    const snapshot = drag.current;
    if (!snapshot) return;
    const row = Math.max(0, Math.min(bounds.height - 1, event.y - bounds.y));
    const line = snapshot.visual[snapshot.start + row];
    if (!line) return;
    const focus = line.start + offsetAtColumn(line.text, Math.max(0, event.x - bounds.x - PROMPT.length));
    snapshot.focus = focus;
    setSelection({ anchor: snapshot.anchor, focus });
    if (event.action === 'release') {
      drag.current = undefined;
      setCursor(focus);
      const text = snapshot.text.slice(Math.min(snapshot.anchor, focus), Math.max(snapshot.anchor, focus));
      if (text) {
        if (copySelection) copySelection(text);
        else void copyTerminalSelection(text).catch(() => {});
      } else setSelection(undefined);
    }
  });
  useEffect(() => {
    drag.current = undefined;
    setSelection(undefined);
  }, [value, columns, rows, resizing]);
  const maxInputRows = mouseEnabled ? Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor(rows / 3))) : MAX_INPUT_ROWS;
  // Reopen the completion menu and reset its selection whenever the input
  // changes. (The cursor is a static block — no blink timer.)
  useEffect(() => {
    setMenuOpen(true);
    setMenuIndex(0);
  }, [value, cursor]);

  // Completion follows the whitespace-delimited token containing the caret.
  const tokens = inputTokens(value);
  const activeToken = tokens.find(token => cursor > token.start && cursor <= token.end);
  const sigil = activeToken?.sigil ?? '';
  const partial = activeToken?.name ?? '';
  const pool = sigil === '/' ? commands : sigil === '$' ? skills : [];
  const suggestions = sigil
    ? pool.filter(item => item.name.startsWith(partial)).slice(0, mouseEnabled ? Math.max(1, Math.min(MENU_LIMIT, Math.floor(rows / 4))) : MENU_LIMIT)
    : [];
  const showMenu = menuOpen && suggestions.length > 0;
  const menuIdx = Math.min(menuIndex, Math.max(0, suggestions.length - 1));
  // When the only suggestion is already fully typed (e.g. `/think`), the menu has
  // nothing to navigate — so ↑/↓ should fall through to history instead of being
  // trapped cycling a single item.
  const menuNavigable = showMenu && !(suggestions.length === 1 && suggestions[0].name === partial);

  const set = (next: string, caret = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(caret, next.length)));
    setHistIndex(null);
  };

  const insertNewline = () => set(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
  const acceptSuggestion = (name: string) => {
    if (!activeToken) return;
    const prefix = value.slice(0, activeToken.start);
    const token = `${sigil}${name}`;
    const suffix = value.slice(activeToken.end);
    const separator = suffix.length === 0 ? ' ' : '';
    set(`${prefix}${token}${separator}${suffix}`, prefix.length + token.length + 1);
  };

  // The cursor's visual (wrapped) line/column, using the same width as the
  // renderer, so ↑/↓ can move between lines and detect the first/last line.
  const cursorVisual = (): { line: number; column: number; visual: VisualLine[] } => {
    const width = Math.max(1, columns - PROMPT.length - 1);
    const visual = wrapToVisualLines(value, width);
    return { ...locateVisualCursor(visual, cursorRef.current), visual };
  };

  useInput((input, key) => {
    const cursor = cursorRef.current;
    if (key.eventType === 'release') return;
    if (key.pageUp || key.pageDown || (mouseEnabled && key.ctrl && key.end)) return;
    drag.current = undefined;
    setSelection(undefined);
    if (key.ctrl && input === 'c') return onInterrupt('ctrl-c');
    if (resizing) return; // ignore typing mid-resize (the box is collapsed)

    // The completion menu intercepts navigation/accept/dismiss before history,
    // submit, and Esc-to-cancel.
    if (showMenu) {
      if (menuNavigable && key.upArrow) return setMenuIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
      if (menuNavigable && key.downArrow) return setMenuIndex(i => (i >= suggestions.length - 1 ? 0 : i + 1));
      if (key.tab) return acceptSuggestion(suggestions[menuIdx].name);
      if (key.escape) return setMenuOpen(false);
      // Enter accepts the highlighted item unless it is already fully typed,
      // in which case it falls through and submits.
      if (key.return && !key.shift && !key.meta && !key.ctrl && partial !== suggestions[menuIdx].name) {
        return acceptSuggestion(suggestions[menuIdx].name);
      }
    }

    if (key.escape) return onInterrupt('escape');
    if (key.tab) return; // no menu: nothing to complete

    // Ctrl+J (LF) is the cross-terminal newline; some terminals also deliver it
    // as a bare '\n' or as a modifyOtherKeys/CSI-u escape for modified Enter.
    if ((key.ctrl && input === 'j') || input === '\n' || isModifiedReturn(input)) {
      return insertNewline();
    }
    if (key.return) {
      if (key.shift || key.meta || key.ctrl) return insertNewline();
      if (value.endsWith('\\')) return set(`${value.slice(0, -1)}\n`);
      const submitted = value;
      const attached = images;
      setValue('');
      setCursor(0);
      setHistIndex(null);
      setImages([]);
      onSubmit(submitted, attached);
      return;
    }

    if ((key.ctrl && input === 'a') || key.home) return setCursor(0);
    if ((key.ctrl && input === 'e') || key.end) return setCursor(value.length);
    if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
    if (key.ctrl && input === 'k') return set(value.slice(0, cursor), cursor);
    const wordLeft = (key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === 'b');
    const wordRight = (key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === 'f');
    if (wordLeft) return setCursor(previousWord(value, cursor));
    if (wordRight) return setCursor(nextWord(value, cursor));
    if ((key.ctrl && input === 'w') || (key.meta && key.backspace)) {
      const start = key.meta ? previousWord(value, cursor) : wordStart(value, cursor);
      set(value.slice(0, start) + value.slice(cursor), start);
      return;
    }

    if (key.leftArrow) return setCursor(c => previousBoundary(value, c));
    if (key.rightArrow) return setCursor(c => nextBoundary(value, c));
    // Edge-triggered history (Claude Code style): ↑ recalls history only on the
    // first visual line, ↓ advances it only on the last; otherwise they move the
    // cursor between lines of a multi-line draft. Single-line input has one line
    // that is both first and last, so ↑/↓ keep their plain history behavior.
    if (key.upArrow) {
      const { line, column, visual } = cursorVisual();
      if (line === 0) return historyPrev();
      const target = visual[line - 1];
      return setCursor(target.start + offsetAtColumn(target.text, column));
    }
    if (key.downArrow) {
      const { line, column, visual } = cursorVisual();
      if (line >= visual.length - 1) return historyNext();
      const target = visual[line + 1];
      return setCursor(target.start + offsetAtColumn(target.text, column));
    }

    if (key.backspace || input === '\x7f' || input === '\b') {
      if (cursor === 0) return;
      const start = previousBoundary(value, cursor);
      set(value.slice(0, start) + value.slice(cursor), start);
      return;
    }
    // Forward Delete is distinct from Backspace. Fedora terminals commonly
    // send ESC[3~ for Del, which Ink exposes as key.delete; remove the
    // character under the cursor and leave the cursor in place.
    if (key.delete) {
      if (cursor >= value.length) return;
      set(value.slice(0, cursor) + value.slice(nextBoundary(value, cursor)), cursor);
      return;
    }

    if (key.ctrl || key.meta || !input) return;
    if (input.charCodeAt(0) === 0x1b) return; // drop unhandled escape sequences
    // Keep printable characters and newlines (so multi-line pastes survive),
    // dropping other control bytes.
    const printable = [...input.replace(/\r\n?/g, '\n')].filter(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 10 || (code >= 32 && code !== 127);
    }).join('');
    if (!printable) return;

    // A dropped/pasted image path collapses into a green `[image #n]` token.
    const imageFile = detectImagePath(printable);
    if (imageFile) {
      const token = `[image #${images.length + 1}]`;
      setImages(prev => [...prev, imageFile]);
      set(value.slice(0, cursor) + token + value.slice(cursor), cursor + token.length);
      return;
    }
    set(value.slice(0, cursor) + printable + value.slice(cursor), cursor + printable.length);
  });

  function restoreHistoryEntry(entry: InputHistoryEntry): void {
    const recalled = typeof entry === 'string' ? { text: entry, images: [] } : entry;
    setValue(recalled.text);
    setCursor(recalled.text.length);
    setImages([...recalled.images]);
  }

  function historyPrev(): void {
    if (history.length === 0) return;
    const index = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1);
    if (histIndex === null) setHistDraft({ text: value, images: [...images] });
    restoreHistoryEntry(history[index]);
    setHistIndex(index);
  }

  function historyNext(): void {
    if (histIndex === null) return;
    if (histIndex < history.length - 1) {
      const index = histIndex + 1;
      restoreHistoryEntry(history[index]);
      setHistIndex(index);
    } else {
      restoreHistoryEntry(histDraft);
      setHistIndex(null);
    }
  }

  // Collapsed to a single stable line while the terminal resizes (the component
  // stays mounted, so the typed value is preserved for when the size settles).
  if (resizing) {
    return (
      <Box paddingX={1}>
        <Text color={DIM}>↔ resizing…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showMenu ? (
        <Box flexDirection="column" paddingX={1}>
          {(() => {
            // Align hints into a column: pad each name to the widest name (capped),
            // then clip the hint to what's left so every row is one line.
            const nameCol = Math.min(28, Math.max(...suggestions.map(s => sigil.length + s.name.length)));
            const hintMax = columns - 2 /*padding*/ - 2 /*prefix*/ - nameCol - 2 /*gap*/ - 1;
            return suggestions.map((item, i) => {
              const prefix = i === menuIdx ? '› ' : '  ';
              const name = padTo(truncate(`${sigil}${item.name}`, nameCol), nameCol);
              const hint = item.hint ? truncate(item.hint, hintMax) : '';
              return (
                <Box key={item.name}>
                  <Text color={i === menuIdx ? ACCENT : undefined} bold={i === menuIdx}>{prefix}{name}</Text>
                  {hint ? <Text color={DIM}>{'  '}{hint}</Text> : null}
                </Box>
              );
            });
          })()}
        </Box>
      ) : null}
      {/* Plain-text rules (not an Ink border box, which duplicates on resize).
          `columns - 1` avoids the exact-width wrap. */}
      <Text color={ACCENT}>{RULE.repeat(Math.max(1, columns - 1))}</Text>
      <Box ref={inputRef} flexDirection="column">{renderLines()}</Box>
      <Text color={ACCENT}>{RULE.repeat(Math.max(1, columns - 1))}</Text>
    </Box>
  );

  /** Render the input, explicitly wrapped to the terminal width and windowed to
   * at most MAX_INPUT_ROWS visual lines around the cursor, so the box height
   * stays bounded (and Ink erases it cleanly). The block cursor shows even on
   * the placeholder. */
  function renderLines(): React.ReactElement[] {
    if (value.length === 0 && placeholder) {
      return [
        <Box key={0}>
          <Box width={PROMPT.length} flexShrink={0}>
            <Text color={ACCENT} bold>{PROMPT}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={DIM} inverse>{placeholder.slice(0, 1)}</Text>
            <Text color={DIM}>{placeholder.slice(1)}</Text>
          </Box>
        </Box>,
      ];
    }
    // Reserve the prompt/indent width (2) plus one column for the end-of-line
    // cursor block, so a full line + cursor never soft-wraps past the box.
    const width = Math.max(1, columns - PROMPT.length - 1);
    const visual = wrapToVisualLines(value, width);
    const { line: cursorLine, column: cursorColumn } = locateVisualCursor(visual, cursor);

    const start = drag.current?.start ?? inputWindowStart(visual.length, cursorLine, maxInputRows);
    const shown = visual.slice(start, start + maxInputRows);
    return shown.map((vl, idx) => {
      const globalIndex = start + idx;
      return (
        <Box key={globalIndex}>
          <Box width={PROMPT.length} flexShrink={0}>
            {globalIndex === 0 ? <Text color={ACCENT} bold>{PROMPT}</Text> : <Text>{CONT}</Text>}
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {renderLine(
              vl.text,
              globalIndex === cursorLine ? offsetAtColumn(vl.text, cursorColumn) : -1,
              vl.start,
            )}
          </Box>
        </Box>
      );
    });
  }

  /** Render one line: color inline skill/command tokens and
   * `[image #n]` tokens, and overlay the block cursor — all via a per-character
   * color so the three can overlap (e.g. cursor inside the head). */
  function renderLine(line: string, cursorCol: number, lineStart = 0): React.ReactElement {
    const tokenRanges: Array<[number, number]> = [];
    IMAGE_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_TOKEN.exec(line)) !== null) {
      tokenRanges.push([match.index, match.index + match[0].length]);
    }
    const colorAt = (i: number): string | undefined => {
      const token = tokens.find(token => lineStart + i >= token.start && lineStart + i < token.end);
      if (token) return token.sigil === '$' ? SKILL : COMMAND;
      for (const [s, e] of tokenRanges) if (i >= s && i < e) return ATTACHMENT;
      return undefined;
    };

    const out: React.ReactNode[] = [];
    for (const g of graphemes(line)) {
      out.push(<Text key={g.offset} color={colorAt(g.offset)} inverse={selection && selection.anchor !== selection.focus
        ? lineStart + g.offset >= Math.min(selection.anchor, selection.focus) && lineStart + g.offset < Math.max(selection.anchor, selection.focus)
        : g.offset === cursorCol}>{g.text}</Text>);
    }
    if (cursorCol >= line.length && cursorCol >= 0) {
      out.push(<Text key="cur" inverse> </Text>);
    }
    return <Text>{out.length ? out : ' '}</Text>;
  }
}

/** A trimmed, unquoted image path that exists on disk, or null. */
function detectImagePath(chunk: string): string | null {
  let p = chunk.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\ /g, ' '); // drag-and-drop escapes spaces
  if (!IMAGE_EXT.test(p)) return null;
  try {
    const resolved = path.resolve(expandHome(p));
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && value[i - 1] === ' ') i -= 1;
  while (i > 0 && value[i - 1] !== ' ') i -= 1;
  return i;
}

/** Skip separators and stop at Unicode word boundaries, including CJK text. */
function previousWord(value: string, cursor: number): number {
  let start = 0;
  for (const word of WORDS.segment(value)) {
    if (word.index >= cursor) break;
    if (word.isWordLike) start = word.index;
  }
  return start;
}

function nextWord(value: string, cursor: number): number {
  for (const word of WORDS.segment(value)) {
    const end = word.index + word.segment.length;
    if (word.isWordLike && end > cursor) return end;
  }
  return value.length;
}
