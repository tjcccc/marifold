/**
 * `@` mentions in a prompt: `@name` or `@"name with spaces"`, at the start or
 * after whitespace (so e-mail addresses never match), outside code. They name
 * execution devices, and profiles in project sessions; `@[title]` or `@[id]`
 * names a library artifact instead (`artifactMentions`). The host parses them in
 * `@marifold/core`; `@marifold/client` keeps an identical copy so composers can
 * preview who answers (a client test keeps the two files the same).
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

const MENTION = /(^|\s)@(?:"([^"\r\n]+)"|([^\s"[][^\s"]*))/g;
const ARTIFACT_MENTION = /(^|\s)@\[([^\]\r\n]{1,200})\]/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\r\n]*`/g;
/** Characters that continue a name, so `@guest2` never matches `guest`.
 * CJK text often follows a mention without a space, so it ends the name. */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const continuesName = (char: string) => char !== '' && NAME_CHAR.test(char) && !CJK.test(char);

function codeRanges(text: string): (index: number) => boolean {
  const code = [...text.matchAll(CODE)].map(match => [match.index, match.index + match[0].length] as const);
  return index => code.some(([start, end]) => index >= start && index < end);
}

export function mentionTokens(text: string): MentionToken[] {
  const inCode = codeRanges(text);
  return [...text.matchAll(MENTION)].flatMap(match => {
    const at = match.index + match[1]!.length;
    if (inCode(at)) { return []; }
    const quoted = match[2] !== undefined;
    return [{ at, end: match.index + match[0].length, token: (match[2] ?? match[3])!, quoted }];
  });
}

/** An `@[title]` / `@[id]` artifact mention: `ref` is the trimmed text inside the brackets. */
export interface ArtifactMention {
  at: number;
  end: number;
  ref: string;
}

export function artifactMentions(text: string): ArtifactMention[] {
  const inCode = codeRanges(text);
  return [...text.matchAll(ARTIFACT_MENTION)].flatMap(match => {
    const at = match.index + match[1]!.length;
    const ref = match[2]!.trim();
    return inCode(at) || !ref ? [] : [{ at, end: match.index + match[0].length, ref }];
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
