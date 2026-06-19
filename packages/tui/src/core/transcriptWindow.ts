import type { TranscriptItem } from './appState.js';

export interface TranscriptWindow {
  /** Items to render, oldest-first, guaranteed to fit within `maxRows`. */
  visible: TranscriptItem[];
  /** Count of older items above the window (drives the "↑ N more" hint). */
  hiddenAbove: number;
  /** Count of newer items below the window (drives the "↓ N more" hint). */
  hiddenBelow: number;
}

/**
 * Choose the slice of transcript to show in the fullscreen middle region.
 *
 * Ink's `overflow="hidden"` clipping is unreliable (it samples rather than
 * clips), so we never overflow: walk from the newest item upward, summing
 * estimated heights, and stop when the budget is spent. The topmost partially
 * visible item — and an over-tall newest item — are tail-truncated so the total
 * never exceeds `maxRows`. `scrollOffset` hides N newest items to scroll back.
 */
export function selectTranscriptWindow(
  transcript: TranscriptItem[],
  opts: { columns: number; maxRows: number; scrollOffset: number },
): TranscriptWindow {
  const maxRows = Math.max(1, opts.maxRows);
  const end = Math.max(0, transcript.length - Math.max(0, opts.scrollOffset));
  const visible: TranscriptItem[] = [];
  let budget = maxRows;
  let firstIncluded = end;

  for (let i = end - 1; i >= 0; i -= 1) {
    if (budget <= 0) break;
    const item = transcript[i];
    const height = estimateRows(item, opts.columns);
    if (height <= budget) {
      visible.unshift(item);
      budget -= height;
      firstIncluded = i;
    } else {
      visible.unshift(truncateToTail(item, opts.columns, budget));
      firstIncluded = i;
      budget = 0;
      break;
    }
  }

  return {
    visible,
    hiddenAbove: firstIncluded,
    hiddenBelow: transcript.length - end,
  };
}

/** Conservative rendered-row estimate for one item at the given terminal width.
 * Mirrors the prefixes/padding TranscriptRow and the App wrapper apply. */
export function estimateRows(item: TranscriptItem, columns: number): number {
  switch (item.kind) {
    case 'user':
      return wrapCount(item.text, columns - 4) + 2; // top/bottom divider rules
    case 'assistant':
    case 'notice':
      return wrapCount(item.text, columns - 2);
    case 'tool':
      return Math.max(1, Math.ceil((item.tool.length + item.summary.length + 12) / Math.max(1, columns - 2)));
    case 'verification':
      return Math.max(1, Math.ceil((item.notes.length + 14) / Math.max(1, columns - 2)));
    case 'plan':
      return 1 + item.steps.length + 1; // "Plan" header + steps + marginBottom
    case 'info':
      return Math.max(1, item.lines.length);
    default:
      return 1;
  }
}

function wrapCount(text: string, width: number): number {
  const w = Math.max(1, width);
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / w)), 0);
}

/** Replace a text item's body with its last `maxRows` wrapped lines. Non-text
 * items (plan/tool/verification) are short and returned unchanged. */
function truncateToTail(item: TranscriptItem, columns: number, maxRows: number): TranscriptItem {
  if (maxRows <= 0) return item;
  if (item.kind === 'assistant' || item.kind === 'notice' || item.kind === 'user') {
    const width = Math.max(1, columns - (item.kind === 'user' ? 4 : 2));
    return { ...item, text: tailVisualLines(item.text, width, maxRows) };
  }
  if (item.kind === 'info') {
    return { ...item, lines: item.lines.slice(-Math.max(1, maxRows)) };
  }
  return item;
}

function tailVisualLines(text: string, width: number, maxRows: number): string {
  const visual: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      visual.push('');
      continue;
    }
    for (let start = 0; start < line.length; start += width) {
      visual.push(line.slice(start, start + width));
    }
  }
  return visual.slice(-maxRows).join('\n');
}
