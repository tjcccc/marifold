/**
 * `marifold.skill.v0` — the minimal, invokable model-backed capability.
 *
 * A skill is a prompt template with declared `{{variables}}` and an optional
 * default run mode. It is the shared primitive both the TUI (`$name`) and
 * future graphical Apps build on: the TUI runs it directly, while an App
 * renders the `variables` block as a form before running the same
 * skill. Keep this schema renderer-agnostic.
 */
export const SKILL_SCHEMA_ID = 'marifold.skill.v0';

/** Which surface a skill runs through by default. */
export type SkillMode = 'agent' | 'chat';

export interface SkillVariable {
  name: string;
  description?: string;
  required: boolean;
  /** Used when the caller supplies no value. */
  default?: string;
}

export interface MarifoldSkill {
  name: string;
  description: string;
  /** Prompt template; `{{var}}` placeholders are replaced at run time. */
  prompt: string;
  /** Declared run mode. Undefined means "follow the session's mode" — so a skill
   * invoked in an agent session runs agentically (with tools), and in a chat
   * session runs as a plain turn. A skill pins a mode by declaring `mode:`. */
  mode?: SkillMode;
  variables: SkillVariable[];
  /** Absolute path the skill was loaded from (set by the loader). */
  source?: string;
  /** Where the skill came from: compiled core, shared skills, or a profile's skills/. */
  scope?: 'builtin' | 'global' | 'profile';
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Distinct `{{var}}` names referenced by a prompt template, in first-seen order. */
export function extractTemplateVariables(prompt: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(prompt)) !== null) {
    seen.add(match[1]);
  }
  return [...seen];
}
