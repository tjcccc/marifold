/**
 * Grammar for the composer's tokens — `$skill` (model-backed, runs
 * through the backend), `/command` (deterministic web action), and `@device`. Mirrors the
 * TUI's `$<name>` / `/<name> [args]`. Names are alphanumeric-led with letters,
 * numbers, underscores, and hyphens.
 */

export type Sigil = '$' | '/' | '@';

/** A leading token: sigil + name at a word boundary (space or end), so a path
 * like `/a/b` is NOT mistaken for a command. */
const LEADING = /^([$/])([a-zA-Z0-9][\w-]*)(?=\s|$)/;
/** A full `/command [args]` line (name is the whole first word). */
const COMMAND_LINE = /^\/([a-zA-Z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

/** The leading `$skill`/`/command` token if the text starts with one. */
export function leadingToken(text: string): { sigil: Sigil; token: string } | undefined {
  if (text.startsWith('@')) {
    const mention = /^@(?:"[^"\r\n]+"|[^\s"]+)(?=\s|$)/.exec(text);
    return mention ? { sigil: '@', token: mention[0] } : undefined;
  }
  const match = LEADING.exec(text);
  return match ? { sigil: match[1] as Sigil, token: match[0] } : undefined;
}

/** Complete only the whitespace-delimited token containing the caret.
 * Keep full replacement bounds so editing a token's middle preserves its args. */
export function menuQuery(
  text: string,
  caret = text.length,
): { sigil: Sigil; query: string; start: number; end: number } | undefined {
  const tokens = /(^|\s)(@(?:"[^"\r\n]*"?|[^\s"]*)|[$/][\w-]*)(?=\s|$)/g;
  for (const match of text.matchAll(tokens)) {
    const start = match.index! + match[1].length;
    const token = match[2];
    const end = start + token.length;
    if (caret <= start || caret > end) { continue; }
    return { sigil: token[0] as Sigil, query: token.slice(1).replace(/^"|"$/g, ''), start, end };
  }
  return undefined;
}

/** Preserve all characters while highlighting inline composer tokens. */
export function highlightTokens(text: string): Array<{ text: string; token?: boolean }> {
  const parts: Array<{ text: string; token?: boolean }> = [];
  let end = 0;
  for (const match of text.matchAll(/(^|\s)(@(?:"[^"\r\n]+"|[^\s"]+)|[$/][a-zA-Z0-9][\w-]*)(?=\s|$)/g)) {
    const start = match.index! + match[1].length;
    parts.push({ text: text.slice(end, start) }, { text: match[2], token: true });
    end = start + match[2].length;
  }
  parts.push({ text: text.slice(end) });
  return parts;
}

/** Split a message into its leading token and the remainder, for highlighting. */
export function splitLeading(text: string): { token?: string; rest: string } {
  const lead = leadingToken(text);
  return lead ? { token: lead.token, rest: text.slice(lead.token.length) } : { rest: text };
}

/** Parse a `/command [args]` line. undefined when the text isn't a command
 * (including a path like `/a/b`, where the name isn't a whole first word). */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = COMMAND_LINE.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : undefined;
}

/** One autocomplete/help entry (shared shape for skills and commands). */
export interface Suggestion {
  name: string;
  usage: string;
  description: string;
}

/** The web's `/command` set — useAgentController's send() routes each to
 * runAgentCommand (screens/agent/agentCommands.ts). Keep the two in sync. */
export const WEB_COMMANDS: Suggestion[] = [
  { name: 'help', usage: '/help', description: 'List available commands.' },
  { name: 'status', usage: '/status', description: 'Show profile, model, thinking, and session.' },
  { name: 'copy', usage: '/copy', description: "Copy the last response to the clipboard." },
  { name: 'retry', usage: '/retry', description: 'Re-run your last message.' },
  { name: 'attach-original', usage: '/attach-original <prompt>', description: 'Send this message’s attached images without optimization.' },
  { name: 'new', usage: '/new', description: 'Start a fresh session.' },
  { name: 'think', usage: '/think', description: 'Toggle thinking mode.' },
  { name: 'model', usage: '/model <id>', description: 'Set the session model, e.g. /model xai/grok-4.5.' },
  { name: 'btw', usage: '/btw <text>', description: 'Steer the running task without cancelling it.' },
  { name: 'stop', usage: '/stop', description: 'Cancel the running task.' },
  { name: 'remember', usage: '/remember <text>', description: 'Save a memory for this profile.' },
  { name: 'forget', usage: '/forget <query>', description: 'Forget memories matching a query.' },
  { name: 'context-window', usage: '/context-window', description: 'Show the current context budget.' },
  { name: 'compact', usage: '/compact', description: 'Compact the current session now.' },
];
