import stripAnsi from 'strip-ansi';
import { offsetAtColumn } from './inputLayout.js';

export interface Position { row: number; column: number }
export interface Selection { anchor: Position; focus: Position }

export function orderedSelection(selection: Selection): [Position, Position] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus] : [focus, anchor];
}

/** Select visible text without ANSI escapes; coordinates are terminal cells. */
export function selectedText(lines: string[], selection: Selection): string {
  const [start, end] = orderedSelection(selection);
  return lines.slice(start.row, end.row + 1).map((line, index) => {
    const text = stripAnsi(line);
    const row = start.row + index;
    const from = row === start.row ? offsetAtColumn(text, start.column) : 0;
    const to = row === end.row ? offsetAtColumn(text, end.column) : text.length;
    return text.slice(from, to).trimEnd();
  }).join('\n');
}
