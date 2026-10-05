import stripAnsi from 'strip-ansi';
import { offsetAtColumn } from './inputLayout.js';

export interface SelectionLine {
  styled: string;
  source: { text: string };
  start: number;
  end: number;
  padding: number;
}

/** Match wrapped display rows to unwrapped rendered lines, retaining skipped
 * word-wrap spaces and preserving explicit line boundaries. */
export function mapSelectionLines(lines: string[], logicalLines: string[], padding = 1): SelectionLine[] {
  const sources = logicalLines.map(line => ({ text: stripAnsi(line).slice(padding).trimEnd() }));
  let logical = 0;
  let offset = 0;
  return lines.map(styled => {
    let prefix = padding;
    let fragment = stripAnsi(styled).slice(prefix).trimEnd();
    let source = sources[logical];
    if (/^[─━│┌┐└┘╭╮╰╯┬┴┼┤├═║]+$/.test(fragment.trim()) && source && /^[─━│┌┐└┘╭╮╰╯┬┴┼┤├═║]+$/.test(source.text.trim())) {
      logical += 1; offset = 0;
      return { styled, source: { text: fragment }, start: 0, end: fragment.length, padding: prefix };
    }
    let start = source?.text.indexOf(fragment, offset) ?? -1;
    while (start < 0 && fragment.startsWith(' ')) {
      prefix += 1;
      fragment = fragment.slice(1);
      start = source?.text.indexOf(fragment, offset) ?? -1;
    }
    if (!source || start < 0 || source.text.slice(offset, start).trim()) {
      // Layout-only rows or an unfamiliar renderer retain their visible text.
      return { styled, source: { text: fragment }, start: 0, end: fragment.length, padding: prefix };
    }
    const end = start + fragment.length;
    const result = { styled, source, start, end, padding: prefix };
    offset = end;
    if (!source.text.slice(end).trim()) { logical += 1; offset = 0; }
    return result;
  });
}

export interface Position { row: number; column: number }
export interface Selection { anchor: Position; focus: Position }

export function orderedSelection(selection: Selection): [Position, Position] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus] : [focus, anchor];
}

/** Select visible text without ANSI escapes; coordinates are terminal cells. */
export function selectedText(lines: string[] | SelectionLine[], selection: Selection): string {
  const [start, end] = orderedSelection(selection);
  let output = '';
  let previous: SelectionLine | undefined;
  let previousEnd = 0;
  lines.slice(start.row, end.row + 1).forEach((line, index) => {
    const row = start.row + index;
    const styled = typeof line === 'string' ? line : line.styled;
    const text = stripAnsi(styled);
    const from = row === start.row ? offsetAtColumn(text, start.column) : 0;
    const to = row === end.row ? offsetAtColumn(text, end.column) : text.length;
    if (typeof line === 'string') {
      output += (index ? '\n' : '') + text.slice(from, to).trimEnd();
      previous = undefined;
      return;
    }
    const sourceFrom = line.start + Math.max(0, Math.min(line.end - line.start, from - line.padding));
    const sourceTo = line.start + Math.max(0, Math.min(line.end - line.start, to - line.padding));
    if (index) output += previous?.source === line.source ? line.source.text.slice(previousEnd, sourceFrom) : '\n';
    output += line.source.text.slice(sourceFrom, sourceTo);
    previous = line;
    previousEnd = sourceTo;
  });
  return output;
}
