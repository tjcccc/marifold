/** Flatten whitespace (newlines included) and clip to `max` columns with an
 * ellipsis, so list rows and menus stay a single, non-wrapping line. Returns ''
 * when there is no room. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + '…';
}

/** Right-pad with spaces to `width` so adjacent columns line up. */
export function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
