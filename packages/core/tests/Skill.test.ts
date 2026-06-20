import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSkill } from '../src/skill/SkillValidator';
import { renderSkillPrompt, resolveSkillValues } from '../src/skill/SkillTemplater';
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

  it('defaults mode to chat', () => {
    const skill = parseSkill('---\nname: x\n---\nhello\n');
    expect(skill.mode).toBe('chat');
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

  it('skips unparseable skill folders when listing', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), 'no frontmatter here');
    const store = new SkillStore({ globalDir: dir });
    expect(store.list()).toHaveLength(0);
  });
});
