import type { MarifoldSkill } from '@marifold/core';

/**
 * Bind positional `$name` arguments to a skill's declared variables. Each
 * leading token fills one variable in order; the final declared variable
 * absorbs all remaining tokens so free-text trailing args (e.g. the text to
 * translate) work. Missing/optional variables are resolved later by the
 * templater's defaults or by inline prompting in the App.
 */
export function bindSkillArgs(skill: MarifoldSkill, argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const vars = skill.variables;
  for (let i = 0; i < vars.length; i += 1) {
    if (i < vars.length - 1) {
      if (argv[i] !== undefined) values[vars[i].name] = argv[i];
    } else {
      const rest = argv.slice(i).join(' ');
      if (rest.length > 0) values[vars[i].name] = rest;
    }
  }
  return values;
}

/** One-line usage hint, e.g. `$translate <text> [language]`. */
export function skillUsage(skill: MarifoldSkill): string {
  const vars = skill.variables
    .map(variable => (variable.required ? `<${variable.name}>` : `[${variable.name}]`))
    .join(' ');
  return `$${skill.name}${vars ? ` ${vars}` : ''}`;
}
