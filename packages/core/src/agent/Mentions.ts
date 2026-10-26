/**
 * `@` mentions in a prompt: `@name` or `@"name with spaces"`, at the start or
 * after whitespace (so e-mail addresses never match), outside code. Devices
 * use them today; project sessions will also address profiles with them.
 */
export interface MentionToken {
  /** Index of the `@`. */
  at: number;
  /** Index just past the token (after the closing quote when quoted). */
  end: number;
  /** The text after `@`, without quotes. */
  token: string;
  quoted: boolean;
}

const MENTION = /(^|\s)@(?:"([^"\r\n]+)"|([^\s"]+))/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\r\n]*`/g;
/** Characters that continue a name, so `@guest2` never matches `guest`.
 * CJK text often follows a mention without a space, so it ends the name. */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const continuesName = (char: string) => char !== '' && NAME_CHAR.test(char) && !CJK.test(char);

export function mentionTokens(text: string): MentionToken[] {
  const code = [...text.matchAll(CODE)].map(match => [match.index, match.index + match[0].length] as const);
  const inCode = (index: number) => code.some(([start, end]) => index >= start && index < end);
  return [...text.matchAll(MENTION)].flatMap(match => {
    const at = match.index + match[1]!.length;
    if (inCode(at)) { return []; }
    const quoted = match[2] !== undefined;
    return [{ at, end: match.index + match[0].length, token: (match[2] ?? match[3])!, quoted }];
  });
}

/**
 * The candidates a mention names, matched case-insensitively against each
 * candidate's keys (name, id). A quoted mention must match a key exactly. An
 * unquoted one matches exactly, or else by the longest key it starts with
 * when a non-name character follows: `@dev_test,`, `@office's`, `@painter给我`
 * (no space before the prompt), and `@office/~/x` all name their target.
 * `end` is where the matched text stops. Several targets mean the name is ambiguous.
 */
export function matchMention<T>(mention: MentionToken, candidates: readonly T[], keys: (candidate: T) => readonly string[]): { targets: T[]; end: number } {
  const token = mention.token.toLowerCase();
  const exact = candidates.filter(candidate => keys(candidate).some(key => key.toLowerCase() === token));
  if (exact.length > 0 || mention.quoted) { return { targets: exact, end: mention.end }; }
  let length = 0;
  let targets: T[] = [];
  for (const candidate of candidates) {
    for (const key of keys(candidate)) {
      const lower = key.toLowerCase();
      if (!lower || !token.startsWith(lower) || continuesName(mention.token.charAt(lower.length))) { continue; }
      if (lower.length > length) { length = lower.length; targets = [candidate]; } else if (lower.length === length && !targets.includes(candidate)) { targets.push(candidate); }
    }
  }
  return { targets, end: targets.length > 0 ? mention.at + 1 + length : mention.end };
}

/** True when two names would be the same `@` mention. */
export function sameMentionName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
