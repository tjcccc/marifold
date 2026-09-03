import * as path from 'path';

const SKILL_KEYWORDS = [
  'skill',
  'skills',
  '技能',
  'スキル',
  '스킬',
  'habilidad',
  'habilidades',
  'compétence',
  'compétences',
  'fähigkeit',
  'fähigkeiten',
  'habilidade',
  'навык',
  'навыки',
  'навыков',
] as const;

export interface SkillManagerGuideOptions {
  profile: string;
  profilesDir: string;
  globalSkillsDir: string;
}

/** Cheap, deliberately broad trigger for lazily attaching the built-in guide.
 * False positives only add a small context block; they never mutate state. */
export function mentionsSkills(prompt: string): boolean {
  const normalized = prompt.normalize('NFKC').toLowerCase();
  return SKILL_KEYWORDS.some(keyword => containsKeyword(normalized, keyword));
}

/** Path-aware internal guide for ordinary agent runs that mention skills. */
export function buildSkillManagerGuide(options: SkillManagerGuideOptions): string {
  const profileSkillsDir = path.join(options.profilesDir, options.profile, 'skills');
  return `## Internal $skill-manager guide

This request concerns Marifold skills. Follow these rules for any skill inspection, creation, installation, update, or removal:

- The active profile is ${quoted(options.profile)}. Its skill directory is ${quoted(profileSkillsDir)}.
- The global skill directory is ${quoted(options.globalSkillsDir)}. Default every skill creation, installation, update, and removal to this global scope.
- Use a profile's skill directory only when the user explicitly requests --profile <name>. The protected management Skills validate that the named profile exists. Continue to understand --global and -g as redundant compatibility aliases, but do not recommend them.
- A skill lives at <skill-directory>/<name>/SKILL.md, with optional bundled files beside SKILL.md. Never create .claude/skills, .agents/skills, or a skills directory in the working directory.
- Profile skills shadow global skills with the same name. Inspect both exact locations before updating or removing, and change only the intended scope.
- SKILL.md must contain YAML frontmatter with a lowercase name and a non-empty prompt body. Preserve bundled files unless the user asks to replace the whole skill.
- Prefer the validated manage_skill tool for creation, installation, update, or removal. It always targets exactly one scope and protects Marifold's built-in $skill-installer and $skill-creator. Direct filesystem operations for ordinary user skills remain permissible when the user explicitly requests them.
- Confirm destructive or ambiguous changes. After any direct filesystem change, read back SKILL.md to verify it.`;
}

function containsKeyword(text: string, keyword: string): boolean {
  // CJK and Hangul commonly attach particles directly to a noun, so requiring
  // a Unicode word boundary would miss forms such as `技能を` and `스킬을`.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(keyword)) {
    return text.includes(keyword);
  }
  let offset = text.indexOf(keyword);
  while (offset !== -1) {
    const before = text[offset - 1];
    const after = text[offset + keyword.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = text.indexOf(keyword, offset + keyword.length);
  }
  return false;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}
