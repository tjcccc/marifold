import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import type { MarifoldSkill, SkillMode } from './SkillSchema';
import { renderSkillPrompt } from './SkillTemplater';

export interface ParsedSkillInvocation {
  name: string;
  args: string;
  argv: string[];
  displayText: string;
}

export interface ResolvedSkillInvocation {
  name: string;
  userTurn: string;
  /** The ordinary user prompt the model acts on. */
  prompt: string;
  /** Expanded skill body plus the exact bundled-file location. */
  instructions: string[];
  mode?: SkillMode;
  missing: string[];
  usage: string;
}

/** Parse a submitted `$name [args]` turn. Returns undefined for ordinary text. */
export function parseSkillInvocation(raw: string): ParsedSkillInvocation | undefined {
  const displayText = raw.trim();
  if (!displayText.startsWith('$')) return undefined;
  const match = displayText.slice(1).match(/^([a-z0-9][a-z0-9_-]*)\s*([\s\S]*)$/i);
  if (!match) throw MarifoldError.skillInvalid('Expected a skill invocation such as $skill-name [args].');
  return {
    name: match[1].toLowerCase(),
    args: match[2],
    argv: tokenizeSkillArgs(match[2]),
    displayText,
  };
}

/** Split invocation arguments while preserving quoted multi-word values. */
export function tokenizeSkillArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/** Bind positional invocation arguments using the TUI's established rules. */
export function bindSkillArgs(skill: MarifoldSkill, argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < skill.variables.length; index += 1) {
    const variable = skill.variables[index];
    if (index < skill.variables.length - 1) {
      if (argv[index] !== undefined) values[variable.name] = argv[index];
    } else {
      const rest = argv.slice(index).join(' ');
      if (rest.length > 0) values[variable.name] = rest;
    }
  }
  return values;
}

export function skillUsage(skill: MarifoldSkill): string {
  const variables = skill.variables
    .map(variable => (variable.required ? `<${variable.name}>` : `[${variable.name}]`))
    .join(' ');
  return `$${skill.name}${variables ? ` ${variables}` : ''}`;
}

/** Resolve a known skill exactly once, without asking the model to locate it. */
export function resolveSkillInvocation(
  skill: MarifoldSkill,
  parsed: ParsedSkillInvocation,
): ResolvedSkillInvocation {
  if (parsed.name !== skill.name) {
    throw MarifoldError.skillInvalid(`Invocation $${parsed.name} does not match skill '${skill.name}'.`);
  }
  const { prompt: body, missing } = renderSkillPrompt(skill, bindSkillArgs(skill, parsed.argv));
  const bundledDir = skill.source ? path.dirname(skill.source) : undefined;
  const instructions = bundledDir
    ? [
        body,
        `This skill's bundled files are in ${bundledDir}. When the instructions reference files such as vars.toml, read them from there with read_file.`,
      ]
    : [body];
  return {
    name: skill.name,
    userTurn: parsed.displayText,
    prompt: parsed.argv.join(' ').trim() || 'Follow the skill instructions above and produce the output.',
    instructions,
    ...(skill.mode ? { mode: skill.mode } : {}),
    missing,
    usage: skillUsage(skill),
  };
}
