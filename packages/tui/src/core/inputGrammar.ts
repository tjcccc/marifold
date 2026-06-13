/**
 * Classifies a submitted input line into the three TUI primitives:
 *   - `/command [args]` → a deterministic, code-executed command (no model).
 *   - `$skill [args]`   → invoke a model-backed skill (`$<name>` *is* the run).
 *   - plain text        → talk to the agent (or chat in `/chat` mode).
 *
 * Pure and renderer-agnostic so it can be unit-tested without Ink.
 */
export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: string; args: string; argv: string[] }
  | { kind: 'skill'; name: string; args: string; argv: string[] };

/** Split an argument string into whitespace-separated tokens, honoring
 * single/double quotes so `$translate "good morning" ja` parses cleanly. */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  const prefix = trimmed[0];
  if (prefix === '/' || prefix === '$') {
    // Strip the sigil, then split the head token from the remainder.
    const body = trimmed.slice(1);
    const headMatch = body.match(/^(\S+)\s*([\s\S]*)$/);
    const name = (headMatch?.[1] ?? '').toLowerCase();
    const args = headMatch?.[2] ?? '';
    if (name.length === 0) return { kind: 'text', text: trimmed };
    const kind = prefix === '/' ? 'command' : 'skill';
    return { kind, name, args, argv: tokenizeArgs(args) };
  }

  return { kind: 'text', text: trimmed };
}
