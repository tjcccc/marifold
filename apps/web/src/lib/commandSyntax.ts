/**
 * Grammar for the composer's leading tokens — `$skill` (model-backed, runs
 * through the backend) and `/command` (deterministic web action). Mirrors the
 * TUI's `$<name>` / `/<name> [args]`. Names are alphanumeric-led with letters,
 * numbers, underscores, and hyphens.
 */

export type Sigil = '$' | '/';

/** A leading token: sigil + name at a word boundary (space or end), so a path
 * like `/a/b` is NOT mistaken for a command. */
const LEADING = /^([$/])([a-zA-Z0-9][\w-]*)(?=\s|$)/;
/** A leading sigil + partial name, optionally followed by existing arguments. */
const QUERY = /^([$/])([\w-]*)(?=\s|$)/;
/** A full `/command [args]` line (name is the whole first word). */
const COMMAND_LINE = /^\/([a-zA-Z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

/** The leading `$skill`/`/command` token if the text starts with one. */
export function leadingToken(text: string): { sigil: Sigil; token: string } | undefined {
  const match = LEADING.exec(text);
  return match ? { sigil: match[1] as Sigil, token: match[0] } : undefined;
}

/** The leading sigil + partial name while the caret is editing that token.
 * Existing arguments may remain after it; moving the caret into those args
 * closes the menu. `end` is the replacement boundary for completion. */
export function menuQuery(
  text: string,
  caret = text.length,
): { sigil: Sigil; query: string; end: number } | undefined {
  const match = QUERY.exec(text);
  if (!match) return undefined;
  const end = match[0].length;
  if (caret < 1 || caret > end) return undefined;
  return { sigil: match[1] as Sigil, query: match[2], end };
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

/** The web's `/command` set — each is wired to a controller action in
 * useAgentController's send(). Keep in sync with the command switch there. */
export const WEB_COMMANDS: Suggestion[] = [
  { name: 'help', usage: '/help', description: 'List available commands.' },
  { name: 'status', usage: '/status', description: 'Show profile, mode, model, thinking, and session.' },
  { name: 'copy', usage: '/copy', description: "Copy the last response to the clipboard." },
  { name: 'retry', usage: '/retry', description: 'Re-run your last message.' },
  { name: 'attach-original', usage: '/attach-original <prompt>', description: 'Send this message’s attached images without optimization.' },
  { name: 'new', usage: '/new', description: 'Start a fresh session.' },
  { name: 'agent', usage: '/agent', description: 'Set the profile to agent mode.' },
  { name: 'chat', usage: '/chat', description: 'Set the profile to chat mode.' },
  { name: 'think', usage: '/think', description: 'Toggle thinking mode.' },
  { name: 'model', usage: '/model <id>', description: 'Set the session model, e.g. /model xai/grok-4.5.' },
  { name: 'btw', usage: '/btw <text>', description: 'Steer the running task without cancelling it.' },
  { name: 'stop', usage: '/stop', description: 'Cancel the running task.' },
  { name: 'remember', usage: '/remember <text>', description: 'Save a memory for this profile.' },
  { name: 'forget', usage: '/forget <query>', description: 'Forget memories matching a query.' },
  { name: 'context-window', usage: '/context-window', description: 'Show the current context budget.' },
  { name: 'compact', usage: '/compact', description: 'Compact the current session now.' },
];
