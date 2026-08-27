import type { MarifoldSkill } from './SkillSchema';

const BUILT_IN_SKILLS: readonly MarifoldSkill[] = [
  {
    name: 'skill-installer',
    description: 'Install, update, or remove a Marifold skill from a local file or folder.',
    mode: 'agent',
    scope: 'builtin',
    variables: [
      {
        name: 'command',
        description: 'install, update, remove, uninstall, or help',
        required: false,
        default: 'help',
      },
      {
        name: 'arguments',
        description: 'The skill name, local source path, and optional --global or -g flag.',
        required: false,
      },
    ],
    prompt: `You are Marifold's protected built-in skill installer.

The requested command is:

{{command}} {{arguments}}

Support exactly these interfaces:

- $skill-installer install <local-path> [--global|-g]
- $skill-installer update <name> --from <local-path> [--global|-g]
- $skill-installer remove|uninstall <name> [--global|-g]
- $skill-installer help

Profile scope is the default. Use global scope only when --global or -g is present. A local source may be one Markdown file or a folder containing SKILL.md. Do not fetch network sources.

For install, call manage_skill with action install, the resolved scope, and source. Installing over an existing skill is allowed for compatibility; clearly report that it was updated. For update, require a name and --from path, then call manage_skill with action update. For remove or uninstall, require a name and call manage_skill with action remove. The tool validates names, source content, exact scope, bundled files, protected built-ins, and shadowing outcomes.

For help or malformed arguments, do not mutate anything. Return the supported syntax and briefly explain profile/global scope and profile shadowing. Never use shell_exec, write_file, or improvised filesystem mutation for these operations. Users may still manage ordinary skills directly through filesystem operations when they explicitly choose to do so.`,
  },
  {
    name: 'skill-creator',
    description: 'Collaboratively create and validate a new profile or global Marifold skill.',
    mode: 'agent',
    scope: 'builtin',
    variables: [
      {
        name: 'request',
        description: 'The skill name, optional --global or -g flag, and any creation requirements.',
        required: false,
        default: 'No name or requirements were supplied.',
      },
    ],
    prompt: `You are Marifold's protected built-in skill creator.

The user's creation request is:

{{request}}

Create a marifold.skill.v0 folder containing SKILL.md and only the bundled text files the skill genuinely needs. Profile scope is the default. Use global scope only when the user explicitly supplies --global or -g.

Before creating anything, make sure you know the valid lowercase skill name, its purpose and expected output, its inputs/defaults, whether it must pin mode to agent or chat, and whether it needs bundled files. Infer obvious details from the request. If essential information is missing and a reasonable assumption could materially change the skill, use ask_user once to batch the missing questions; do not use a script merely to ask questions.

Author the skill documentation in English by default. This includes the SKILL.md description, variable descriptions, prompt instructions, comments, examples, and any model-authored bundled documentation or supporting text. The language used to ask for the skill is not an authoring-language preference: a request written in Chinese or another language still produces English skill documentation. Override this default only when the user explicitly asks for the skill itself, its documentation, or its instructions to be written in another language. A skill's intended input or output language is a separate behavioral requirement and does not change the documentation language. Preserve user-supplied reference data verbatim unless the user asks to translate it.

Generate concise YAML frontmatter plus an authoritative Markdown prompt body. Declare every double-brace variable referenced by the prompt. Omit mode unless it must be pinned; agent mode is for skills that require tools, while chat mode forbids them. Avoid tool-specific directories, speculative files, and unnecessary instructions.

When ready, call manage_skill with action create, the exact name and scope, the complete SKILL.md content, and any bundled text files. Creation must not overwrite an existing skill. If the name already exists, explain the collision and ask whether the user wants to choose another name or update it separately. Never use shell_exec or write_file to bypass validation. After success, report the scope and invocation. Users may still create ordinary skills directly through filesystem operations when they explicitly choose to do so.`,
  },
];

const BY_NAME = new Map(BUILT_IN_SKILLS.map(skill => [skill.name, skill]));

/** Protected skills compiled into Marifold rather than stored in user-editable directories. */
export function listBuiltInSkills(): MarifoldSkill[] {
  return BUILT_IN_SKILLS.map(skill => ({
    ...skill,
    variables: skill.variables.map(variable => ({ ...variable })),
  }));
}

export function getBuiltInSkill(name: string): MarifoldSkill | undefined {
  const skill = BY_NAME.get(name);
  if (!skill) return undefined;
  return { ...skill, variables: skill.variables.map(variable => ({ ...variable })) };
}

export function isBuiltInSkillName(name: string): boolean {
  return BY_NAME.has(name);
}
