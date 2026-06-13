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

const TRANSLATE = `schema = "marifold.skill.v0"
name = "translate"
description = "Translate text."
mode = "chat"
prompt = "Translate into {{language}}:\\n\\n{{text}}"

[[variables]]
name = "text"
required = true

[[variables]]
name = "language"
default = "English"
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

  it('defaults mode to agent', () => {
    const skill = parseSkill('schema = "marifold.skill.v0"\nname = "x"\nprompt = "hello"\n');
    expect(skill.mode).toBe('agent');
  });

  it.each([
    ['wrong schema', 'schema = "other"\nname = "x"\nprompt = "p"\n'],
    ['missing name', 'schema = "marifold.skill.v0"\nprompt = "p"\n'],
    ['empty prompt', 'schema = "marifold.skill.v0"\nname = "x"\nprompt = "   "\n'],
    ['bad name', 'schema = "marifold.skill.v0"\nname = "Bad Name"\nprompt = "p"\n'],
    ['undeclared variable', 'schema = "marifold.skill.v0"\nname = "x"\nprompt = "hi {{who}}"\n'],
  ])('rejects %s', (_label: string, text: string) => {
    expect(() => parseSkill(text)).toThrow();
  });

  it('rejects duplicate variables', () => {
    const text = 'schema = "marifold.skill.v0"\nname = "x"\nprompt = "{{a}}"\n[[variables]]\nname = "a"\n[[variables]]\nname = "a"\n';
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

  it('skips unparseable files when listing', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'broken.toml'), 'not a skill = [');
    const store = new SkillStore({ globalDir: dir });
    expect(store.list()).toHaveLength(0);
  });
});
