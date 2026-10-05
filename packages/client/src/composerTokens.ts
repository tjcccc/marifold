export interface ComposerToken {
  start: number;
  end: number;
  imageNumber?: number;
}

/** Atomic Backspace applies at a token's end; editing inside it stays ordinary. */
export function composerTokenBefore(text: string, cursor: number): ComposerToken | undefined {
  for (const match of text.matchAll(/(^|\s)([$/][\w-]+|\[image #(\d+)\])(?=\s|$)/g)) {
    const start = match.index! + match[1].length;
    const end = start + match[2].length;
    if (end === cursor) return { start, end, ...(match[3] ? { imageNumber: Number(match[3]) } : {}) };
  }
  return undefined;
}
