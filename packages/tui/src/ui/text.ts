import stringWidth from 'string-width';

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Flatten whitespace (newlines included) and clip to `max` terminal columns
 * with an ellipsis, so list rows and menus stay a single, non-wrapping line.
 * Wide characters (CJK, emoji) count as two columns. Returns '' when there is
 * no room. */
export function truncate(text: string, max: number): string {
  if (max <= 0) { return ''; }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(flat) <= max) { return flat; }
  let kept = '';
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(flat)) {
    const next = stringWidth(segment);
    if (width + next > max - 1) { break; }
    kept += segment;
    width += next;
  }
  return kept + '…';
}

/** Right-pad with spaces to `width` terminal columns so adjacent columns line up. */
export function padTo(text: string, width: number): string {
  const current = stringWidth(text);
  return current >= width ? text : text + ' '.repeat(width - current);
}
