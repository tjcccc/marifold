export interface InputToken {
  start: number;
  end: number;
  sigil: '$' | '/';
  name: string;
}

/** Whitespace-delimited tokens; paths and sigils inside words stay plain. */
export function inputTokens(text: string): InputToken[] {
  return Array.from(text.matchAll(/(^|\s)([$/])([\w-]*)(?=\s|$)/g), match => ({
    start: match.index! + match[1].length,
    end: match.index! + match[0].length,
    sigil: match[2] as '$' | '/',
    name: match[3],
  }));
}
