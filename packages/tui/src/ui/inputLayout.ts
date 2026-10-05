import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export interface VisualLine { text: string; start: number }

export function graphemes(text: string): Array<{ text: string; offset: number; width: number }> {
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({
    text: segment, offset: index, width: stringWidth(segment),
  }));
}

export function previousBoundary(text: string, cursor: number): number {
  return graphemes(text).filter(g => g.offset < cursor).at(-1)?.offset ?? 0;
}

export function nextBoundary(text: string, cursor: number): number {
  return graphemes(text).find(g => g.offset > cursor)?.offset ?? text.length;
}

export function offsetAtColumn(text: string, column: number): number {
  let x = 0;
  for (const g of graphemes(text)) {
    if (column < x + g.width) return g.offset;
    x += g.width;
  }
  return text.length;
}

export function wrapToVisualLines(value: string, width: number): VisualLine[] {
  const visual: VisualLine[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    let text = '';
    let start = 0;
    let columns = 0;
    let wrapped = false;
    for (const g of graphemes(line)) {
      if (text && columns + g.width > width) {
        visual.push({ text, start: offset + start });
        text = '';
        columns = 0;
        start = g.offset;
        wrapped = true;
      }
      if (wrapped && !text && g.text === ' ') {
        start = g.offset + g.text.length;
        continue;
      }
      text += g.text;
      columns += g.width;
    }
    if (text || !line) visual.push({ text, start: offset + start });
    offset += line.length + 1;
  }
  return visual.length ? visual : [{ text: '', start: 0 }];
}

export function locateVisualCursor(visual: VisualLine[], cursor: number): { line: number; column: number } {
  for (let i = 0; i < visual.length; i++) {
    const { start, text } = visual[i];
    const end = start + text.length;
    const nextStart = visual[i + 1]?.start;
    if (cursor >= start && cursor <= end) {
      if (cursor === end && nextStart === end) continue;
      return { line: i, column: stringWidth(text.slice(0, cursor - start)) };
    }
    if (nextStart !== undefined && cursor > end && cursor < nextStart) return { line: i + 1, column: 0 };
  }
  const last = visual.length - 1;
  return { line: last, column: stringWidth(visual[last].text) };
}

export function inputWindowStart(total: number, cursorLine: number, maxRows: number): number {
  return Math.min(Math.max(0, cursorLine - (maxRows - 1)), Math.max(0, total - maxRows));
}
