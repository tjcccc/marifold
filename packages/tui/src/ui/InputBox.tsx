import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import * as fs from 'fs';
import * as path from 'path';
import { expandHome } from '@marifold/core';
import { ACCENT, ATTACHMENT, COMMAND, DIM, SKILL } from './theme.js';
import { padTo, truncate } from './text.js';

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
 * Multi-line input with a blinking block cursor, history, readline shortcuts,
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
  onSubmit: (value: string, images: string[]) => void;
  onInterrupt: (reason: 'ctrl-c' | 'escape') => void;
  placeholder?: string;
  history: string[];
  commands: CompletionItem[];
  skills: CompletionItem[];
  /** While the terminal is resizing, collapse to a single line and ignore
   * typing so Ink's erase math can't desync and duplicate the input box. */
  resizing?: boolean;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [histDraft, setHistDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(true);

  // Terminal width, kept current across resizes, for explicit input wrapping.
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setColumns(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Reopen the completion menu and reset its selection whenever the input
  // changes. (The cursor is a static block — no blink timer.)
  useEffect(() => {
    setMenuOpen(true);
    setMenuIndex(0);
  }, [value, cursor]);

  // Completion menu: only on the head token `/x` or `$x` (no space/newline yet).
  const headMatch = value.match(/^([/$])(\S*)$/);
  const sigil = headMatch?.[1] ?? '';
  const partial = headMatch?.[2] ?? '';
  const pool = sigil === '/' ? commands : sigil === '$' ? skills : [];
  const suggestions = sigil
    ? pool.filter(item => item.name.startsWith(partial)).slice(0, MENU_LIMIT)
    : [];
  const showMenu = menuOpen && suggestions.length > 0;
  const menuIdx = Math.min(menuIndex, Math.max(0, suggestions.length - 1));
  // When the only suggestion is already fully typed (e.g. `/chat`), the menu has
  // nothing to navigate — so ↑/↓ should fall through to history instead of being
  // trapped cycling a single item.
  const menuNavigable = showMenu && !(suggestions.length === 1 && suggestions[0].name === partial);

  const set = (next: string, caret = next.length) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(caret, next.length)));
    setHistIndex(null);
  };

  const insertNewline = () => set(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
  const acceptSuggestion = (name: string) => set(`${sigil}${name} `);

  // The cursor's visual (wrapped) line/column, using the same width as the
  // renderer, so ↑/↓ can move between lines and detect the first/last line.
  const cursorVisual = (): { line: number; column: number; visual: VisualLine[] } => {
    const width = Math.max(1, columns - PROMPT.length - 1);
    const visual = wrapToVisualLines(value, width);
    return { ...locateVisualCursor(visual, cursor), visual };
  };

  useInput((input, key) => {
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
    if (key.ctrl && input === 'w') {
      const start = wordStart(value, cursor);
      set(value.slice(0, start) + value.slice(cursor), start);
      return;
    }

    if (key.leftArrow) return setCursor(c => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor(c => Math.min(value.length, c + 1));
    // Edge-triggered history (Claude Code style): ↑ recalls history only on the
    // first visual line, ↓ advances it only on the last; otherwise they move the
    // cursor between lines of a multi-line draft. Single-line input has one line
    // that is both first and last, so ↑/↓ keep their plain history behavior.
    if (key.upArrow) {
      const { line, column, visual } = cursorVisual();
      if (line === 0) return historyPrev();
      const target = visual[line - 1];
      return setCursor(target.start + Math.min(column, target.text.length));
    }
    if (key.downArrow) {
      const { line, column, visual } = cursorVisual();
      if (line >= visual.length - 1) return historyNext();
      const target = visual[line + 1];
      return setCursor(target.start + Math.min(column, target.text.length));
    }

    if (key.backspace || key.delete || input === '\x7f' || input === '\b') {
      if (cursor === 0) return;
      set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
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
      <Box flexDirection="column">{renderLines()}</Box>
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
          <Text color={ACCENT} bold>{PROMPT}</Text>
          <Text color={DIM} inverse>{placeholder.slice(0, 1)}</Text>
          <Text color={DIM}>{placeholder.slice(1)}</Text>
        </Box>,
      ];
    }
    // Reserve the prompt/indent width (2) plus one column for the end-of-line
    // cursor block, so a full line + cursor never soft-wraps past the box.
    const width = Math.max(1, columns - PROMPT.length - 1);
    const visual = wrapToVisualLines(value, width);
    const { line: cursorLine, column: cursorColumn } = locateVisualCursor(visual, cursor);

    let start = 0;
    if (visual.length > MAX_INPUT_ROWS) {
      start = Math.min(Math.max(0, cursorLine - (MAX_INPUT_ROWS - 1)), visual.length - MAX_INPUT_ROWS);
    }
    // Color the leading `$name` / `/cmd` head token (line 0 only).
    const headMatch = value.match(/^([/$])\S*/);
    const headColor = headMatch ? (headMatch[1] === '$' ? SKILL : COMMAND) : undefined;
    const headLen = headMatch ? headMatch[0].length : 0;

    const shown = visual.slice(start, start + MAX_INPUT_ROWS);
    return shown.map((vl, idx) => {
      const globalIndex = start + idx;
      return (
        <Box key={globalIndex}>
          {globalIndex === 0 ? <Text color={ACCENT} bold>{PROMPT}</Text> : <Text>{CONT}</Text>}
          <Box flexGrow={1}>
            {renderLine(
              vl.text,
              globalIndex === cursorLine ? cursorColumn : -1,
              globalIndex === 0 ? headLen : 0,
              headColor,
            )}
          </Box>
        </Box>
      );
    });
  }

  /** Render one line: color the head token (`headLen` chars in `headColor`) and
   * `[image #n]` tokens, and overlay the block cursor — all via a per-character
   * color so the three can overlap (e.g. cursor inside the head). */
  function renderLine(line: string, cursorCol: number, headLen = 0, headColor?: string): React.ReactElement {
    const tokenRanges: Array<[number, number]> = [];
    IMAGE_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_TOKEN.exec(line)) !== null) {
      tokenRanges.push([match.index, match.index + match[0].length]);
    }
    const colorAt = (i: number): string | undefined => {
      if (i < headLen) return headColor;
      for (const [s, e] of tokenRanges) if (i >= s && i < e) return ATTACHMENT;
      return undefined;
    };

    const out: React.ReactNode[] = [];
    let key = 0;
    let i = 0;
    while (i < line.length) {
      if (i === cursorCol) {
        out.push(<Text key={key++} color={colorAt(i)} inverse>{line[i]}</Text>);
        i += 1;
        continue;
      }
      const color = colorAt(i);
      let j = i + 1;
      while (j < line.length && j !== cursorCol && colorAt(j) === color) j += 1;
      out.push(<Text key={key++} color={color}>{line.slice(i, j)}</Text>);
      i = j;
    }
    if (cursorCol >= line.length && cursorCol >= 0) {
      out.push(<Text key="cur" inverse> </Text>);
    }
    return <Text>{out.length ? out : ' '}</Text>;
  }
}

interface VisualLine {
  text: string;
  /** Flat offset of this visual line's first character within the value. */
  start: number;
}

/** Wrap the value into visual lines: split on newlines, then hard-wrap each
 * logical line at `width`. Each entry records where it starts in the value so
 * the cursor can be mapped back. */
function wrapToVisualLines(value: string, width: number): VisualLine[] {
  const visual: VisualLine[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    if (line.length === 0) {
      visual.push({ text: '', start: offset });
    } else {
      for (let c = 0; c < line.length; c += width) {
        visual.push({ text: line.slice(c, c + width), start: offset + c });
      }
    }
    offset += line.length + 1; // account for the consumed newline
  }
  if (visual.length === 0) visual.push({ text: '', start: 0 });
  return visual;
}

/** Map the flat cursor offset onto its (visual line, column). */
function locateVisualCursor(visual: VisualLine[], cursor: number): { line: number; column: number } {
  for (let i = 0; i < visual.length; i += 1) {
    const start = visual[i].start;
    const end = start + visual[i].text.length;
    if (cursor >= start && cursor <= end) {
      // At a wrap boundary (the next visual line continues the same logical line
      // at this offset), show the cursor at the start of that next line.
      if (cursor === end && i + 1 < visual.length && visual[i + 1].start === end) continue;
      return { line: i, column: cursor - start };
    }
  }
  const last = visual.length - 1;
  return { line: last, column: visual[last].text.length };
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
