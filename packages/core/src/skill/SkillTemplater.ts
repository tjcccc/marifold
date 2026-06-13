import { MarifoldSkill } from './SkillSchema';

export interface SkillRenderResult {
  /** The expanded prompt with every `{{var}}` resolved. */
  prompt: string;
  /** Required variables that had neither a supplied value nor a default. */
  missing: string[];
}

/**
 * Effective value for each declared variable: the supplied value, else the
 * declared default. Required variables with neither are reported as missing so
 * the caller (TUI inline prompt, or a SkillApp form) can collect them.
 */
export function resolveSkillValues(
  skill: MarifoldSkill,
  supplied: Record<string, string>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const variable of skill.variables) {
    const provided = supplied[variable.name];
    if (provided !== undefined && provided !== '') {
      values[variable.name] = provided;
    } else if (variable.default !== undefined) {
      values[variable.name] = variable.default;
    } else if (variable.required) {
      missing.push(variable.name);
    } else {
      values[variable.name] = '';
    }
  }
  return { values, missing };
}

/** Expand a skill's prompt template against supplied variable values. */
export function renderSkillPrompt(
  skill: MarifoldSkill,
  supplied: Record<string, string>,
): SkillRenderResult {
  const { values, missing } = resolveSkillValues(skill, supplied);
  const prompt = skill.prompt.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, name: string) => values[name] ?? '',
  );
  return { prompt, missing };
}
