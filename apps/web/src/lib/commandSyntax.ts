/**
 * Shared grammar for the composer's `$skill` syntax — matches the TUI's
 * `$<name> [args]`. Skill names are alphanumeric-led with letters, numbers,
 * underscores, and hyphens. Only `$skill` is recognized today; `/command` is
 * intentionally out of scope until the web has slash-commands.
 */

const LEADING_SKILL = /^(\$[a-zA-Z0-9][\w-]*)/;
// The whole input is a bare `$` + partial name (no space/args yet).
const SKILL_QUERY = /^\$([\w-]*)$/;

/** The leading `$skill` token if the text starts with one (e.g. from
 * `$make-midjourney-prompt #photo1 …` → `$make-midjourney-prompt`). */
export function leadingSkillToken(text: string): string | undefined {
  const match = LEADING_SKILL.exec(text);
  return match ? match[1] : undefined;
}

/** The partial skill name to autocomplete while the user is still typing the
 * first token — `''` right after `$`, `'make'` for `$make`, undefined once a
 * space (args) or non-`$` text appears. */
export function skillQuery(text: string): string | undefined {
  const match = SKILL_QUERY.exec(text);
  return match ? match[1] : undefined;
}

/** Split a message into its leading `$skill` token and the remainder, for
 * highlighting. `token` is undefined when the text isn't a skill invocation. */
export function splitLeadingSkill(text: string): { token?: string; rest: string } {
  const token = leadingSkillToken(text);
  return token ? { token, rest: text.slice(token.length) } : { rest: text };
}
