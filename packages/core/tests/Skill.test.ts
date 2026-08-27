import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSkillManagerGuide, mentionsSkills } from '../src/skill/BuiltInSkillManager';
import { getBuiltInSkill, listBuiltInSkills } from '../src/skill/BuiltInSkills';
import { parseSkill } from '../src/skill/SkillValidator';
import { renderSkillPrompt, resolveSkillValues } from '../src/skill/SkillTemplater';
import {
  bindSkillArgs,
  parseSkillInvocation,
  resolveSkillInvocation,
} from '../src/skill/SkillInvocation';
import { SkillStore } from '../src/skill/SkillStore';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skill-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const TRANSLATE = `---
name: translate
description: Translate text.
mode: chat
variables:
  - name: text
    required: true
  - name: language
    default: English
---

Translate into {{language}}:

{{text}}
`;

describe('parseSkill', () => {
  it('parses a valid marifold.skill.v0 file', () => {
    const skill = parseSkill(TRANSLATE);
    expect(skill.name).toBe('translate');
    expect(skill.mode).toBe('chat');
    expect(skill.variables.map(v => v.name)).toEqual(['text', 'language']);
    expect(skill.variables[0].required).toBe(true);
    expect(skill.variables[1].default).toBe('English');
  });

  it('leaves mode undefined when not declared (run follows the session mode)', () => {
    const skill = parseSkill('---\nname: x\n---\nhello\n');
    expect(skill.mode).toBeUndefined();
  });

  it.each([
    ['no frontmatter', 'just a body, no frontmatter\n'],
    ['wrong schema', '---\nschema: other\nname: x\n---\np\n'],
    ['missing name', '---\ndescription: d\n---\np\n'],
    ['empty prompt', '---\nname: x\n---\n   '],
    ['bad name', '---\nname: Bad Name\n---\np\n'],
    ['undeclared variable', '---\nname: x\n---\nhi {{who}}\n'],
  ])('rejects %s', (_label: string, text: string) => {
    expect(() => parseSkill(text)).toThrow();
  });

  it('rejects duplicate variables', () => {
    const text = '---\nname: x\nvariables:\n  - name: a\n  - name: a\n---\n{{a}}\n';
    expect(() => parseSkill(text)).toThrow(/[Dd]uplicate/);
  });
});

describe('renderSkillPrompt', () => {
  it('substitutes supplied values and applies defaults', () => {
    const skill = parseSkill(TRANSLATE);
    const { prompt, missing } = renderSkillPrompt(skill, { text: 'hello' });
    expect(prompt).toContain('Translate into English');
    expect(prompt).toContain('hello');
    expect(missing).toEqual([]);
  });

  it('reports missing required variables with no default', () => {
    const skill = parseSkill(TRANSLATE);
    const { missing } = renderSkillPrompt(skill, {});
    expect(missing).toEqual(['text']);
  });

  it('resolveSkillValues fills defaults and flags missing', () => {
    const skill = parseSkill(TRANSLATE);
    const { values, missing } = resolveSkillValues(skill, { text: 'hi' });
    expect(values).toEqual({ text: 'hi', language: 'English' });
    expect(missing).toEqual([]);
  });
});

describe('skill invocation', () => {
  it('parses quoted arguments and resolves a skill without filesystem discovery', () => {
    const source = path.join(tempDir(), 'translate', 'SKILL.md');
    const skill = { ...parseSkill(TRANSLATE, source), source };
    const parsed = parseSkillInvocation('$translate "good morning" Japanese');
    expect(parsed).toMatchObject({
      name: 'translate',
      argv: ['good morning', 'Japanese'],
    });
    expect(bindSkillArgs(skill, parsed!.argv)).toEqual({
      text: 'good morning',
      language: 'Japanese',
    });

    const resolved = resolveSkillInvocation(skill, parsed!);
    expect(resolved.userTurn).toBe('$translate "good morning" Japanese');
    expect(resolved.prompt).toBe('good morning Japanese');
    expect(resolved.instructions[0]).toContain('Translate into Japanese');
    expect(resolved.instructions[0]).toContain('good morning');
    expect(resolved.instructions).toHaveLength(1);
    expect(resolved.instructions.join('\n')).not.toContain('vars.toml');
    expect(resolved.mode).toBe('chat');
    expect(resolved.missing).toEqual([]);
  });

  it('advertises the exact bundle only when a skill actually has bundled files', () => {
    const folder = path.join(tempDir(), 'translate');
    fs.mkdirSync(folder);
    const source = path.join(folder, 'SKILL.md');
    fs.writeFileSync(source, TRANSLATE);
    fs.writeFileSync(path.join(folder, 'terms.toml'), 'hello = "こんにちは"\n');
    const skill = parseSkill(TRANSLATE, source);

    const resolved = resolveSkillInvocation(
      skill,
      parseSkillInvocation('$translate hello Japanese')!,
    );

    expect(resolved.instructions).toHaveLength(2);
    expect(resolved.instructions[1]).toContain(folder);
    expect(resolved.instructions[1]).toContain('terms.toml');
    expect(resolved.instructions[1]).not.toContain('vars.toml');
  });

  it('reports missing required values before starting a model run', () => {
    const skill = parseSkill(TRANSLATE);
    const parsed = parseSkillInvocation('$translate')!;
    expect(resolveSkillInvocation(skill, parsed).missing).toEqual(['text']);
  });
});

describe('SkillStore', () => {
  it('installs, lists, gets, and removes skills', () => {
    const store = new SkillStore({ globalDir: tempDir() });
    const installed = store.installFromText(TRANSLATE);
    expect(installed.name).toBe('translate');
    expect(installed.scope).toBe('global');

    expect(store.list().map(s => s.name)).toEqual(['translate']);
    expect(store.get('translate')?.description).toBe('Translate text.');
    expect(store.remove('translate')).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('shadows a global skill with a profile skill of the same name', () => {
    const globalDir = tempDir();
    const profileDir = tempDir();
    const store = new SkillStore({ globalDir, profileDir });
    store.installFromText(TRANSLATE, 'global');
    store.installFromText(TRANSLATE.replace('Translate text.', 'Profile override.'), 'profile');

    const skills = store.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('Profile override.');
    expect(store.get('translate')?.scope).toBe('profile');
  });

  it('lists and removes by scope without touching the other layer', () => {
    const store = new SkillStore({ globalDir: tempDir(), profileDir: tempDir() });
    store.installFromText(TRANSLATE, 'global');
    store.installFromText(TRANSLATE, 'profile');

    expect(store.list('global').map(s => s.scope)).toEqual(['global']);
    expect(store.list('profile').map(s => s.scope)).toEqual(['profile']);

    // Scope-aware remove deletes only the profile copy, revealing the global one.
    expect(store.remove('translate', 'profile')).toBe(true);
    expect(store.list('profile')).toHaveLength(0);
    expect(store.get('translate')?.scope).toBe('global');
  });

  it('installs from a skill folder containing SKILL.md', () => {
    const folder = path.join(tempDir(), 'translate');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'SKILL.md'), TRANSLATE);
    const store = new SkillStore({ globalDir: tempDir() });
    expect(store.installFromFile(folder).name).toBe('translate');
    expect(store.list().map(s => s.name)).toEqual(['translate']);
  });

  it('rejects a skill folder without SKILL.md', () => {
    const store = new SkillStore({ globalDir: tempDir() });
    expect(() => store.installFromFile(tempDir())).toThrow(/SKILL\.md/);
  });

  it('rejects a source folder that overlaps its destination without deleting it', () => {
    const globalDir = tempDir();
    const store = new SkillStore({ globalDir });
    store.installFromText(TRANSLATE);
    const installedDir = path.join(globalDir, 'translate');

    expect(() => store.installFromFile(installedDir)).toThrow(/overlaps its destination/);
    expect(fs.readFileSync(path.join(installedDir, 'SKILL.md'), 'utf-8')).toContain('Translate text.');
  });

  it('skips unparseable skill folders when listing', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), 'no frontmatter here');
    const store = new SkillStore({ globalDir: dir });
    expect(store.list()).toHaveLength(0);
  });

  it('reserves protected built-in names in mutable stores', () => {
    const dir = tempDir();
    const store = new SkillStore({ globalDir: dir });
    const text = TRANSLATE
      .replace('name: translate', 'name: skill-installer')
      .replace('Translate text.', 'Not the built-in.');

    expect(() => store.installFromText(text)).toThrow(/protected Marifold built-in/);
    expect(() => store.remove('skill-creator', 'global')).toThrow(/protected Marifold built-in/);

    const collision = path.join(dir, 'skill-installer');
    fs.mkdirSync(collision);
    fs.writeFileSync(path.join(collision, 'SKILL.md'), text);
    const disguised = path.join(dir, 'disguised');
    fs.mkdirSync(disguised);
    fs.writeFileSync(path.join(disguised, 'SKILL.md'), text);
    expect(store.list()).toHaveLength(0);
    expect(store.get('skill-installer')).toBeUndefined();
  });
});

describe('protected built-in skills', () => {
  it('lists the installer and creator as agent-mode built-ins', () => {
    expect(listBuiltInSkills().map(skill => skill.name)).toEqual([
      'skill-installer',
      'skill-creator',
    ]);
    expect(getBuiltInSkill('skill-installer')).toMatchObject({
      mode: 'agent',
      scope: 'builtin',
    });
  });

  it('binds installer subcommands without requiring missing variables', () => {
    const skill = getBuiltInSkill('skill-installer')!;
    const resolved = resolveSkillInvocation(
      skill,
      parseSkillInvocation('$skill-installer update translate --from ./translate -g')!,
    );

    expect(resolved.mode).toBe('agent');
    expect(resolved.missing).toEqual([]);
    expect(resolved.instructions[0]).toContain('update translate --from ./translate -g');
    expect(resolved.instructions[0]).toContain('manage_skill');
  });

  it('turns a bare creator invocation into a clarification-oriented request', () => {
    const skill = getBuiltInSkill('skill-creator')!;
    const resolved = resolveSkillInvocation(skill, parseSkillInvocation('$skill-creator')!);

    expect(resolved.missing).toEqual([]);
    expect(resolved.instructions[0]).toContain('No name or requirements were supplied.');
    expect(resolved.instructions[0]).toContain('ask_user');
  });

  it('defaults created skill documentation to English regardless of request language', () => {
    const skill = getBuiltInSkill('skill-creator')!;
    const resolved = resolveSkillInvocation(
      skill,
      parseSkillInvocation('$skill-creator 创建一个把内容整理成 Markdown 的技能')!,
    );

    expect(resolved.instructions[0]).toContain('Author the skill documentation in English by default.');
    expect(resolved.instructions[0]).toContain('request written in Chinese');
    expect(resolved.instructions[0]).toContain('intended input or output language is a separate behavioral requirement');
    expect(resolved.instructions[0]).toContain('explicitly asks');
  });
});

describe('built-in skill manager guide', () => {
  it.each([
    'install this skill',
    'Update my skills',
    '请更新这个技能',
    'このスキルを削除して',
    '스킬을 설치해 줘',
    'instalar esta habilidad',
    'mettre à jour cette compétence',
    'diese Fähigkeit entfernen',
    'удалить навык',
  ])('detects a skill-related prompt: %s', prompt => {
    expect(mentionsSkills(prompt)).toBe(true);
  });

  it('does not match skill as part of a larger word', () => {
    expect(mentionsSkills('a skillful response')).toBe(false);
    expect(mentionsSkills('just say hello')).toBe(false);
  });

  it('renders resolved profile and global paths', () => {
    const guide = buildSkillManagerGuide({
      profile: 'writer',
      profilesDir: '/tmp/marifold/profiles',
      globalSkillsDir: '/tmp/marifold/shared-skills',
    });
    expect(guide).toContain('Internal $skill-manager guide');
    expect(guide).toContain('/tmp/marifold/profiles/writer/skills');
    expect(guide).toContain('/tmp/marifold/shared-skills');
    expect(guide).toContain('Never create .claude/skills');
    expect(guide).toContain('manage_skill');
    expect(guide).toContain('$skill-installer');
  });
});
