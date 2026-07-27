import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../src/app/AppStore';
import { resolveAppAction } from '../src/app/AppActionResolver';
import { validateAppToml } from '../src/app/AppValidator';
import { parseSkill } from '../src/skill/SkillValidator';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const VALID_TRANSLATOR = `
schema = "marifold.app.v0"

[app]
name = "translator"
title = "Translator"
description = "Translate text."

[[actors]]
name = "translator"
profile = "app_tester"

[[variables]]
name = "target_lang"
type = "enum"
role = "input"
default = "English"
options = ["English", "Japanese"]

[[variables]]
name = "source_text"
type = "string"
role = "input"

[[variables]]
name = "translated_text"
type = "string"
role = "output"

[[layout]]
component = "select"
bind = "target_lang"

[[layout]]
component = "textarea"
bind = "source_text"

[[layout]]
component = "button"
label = "Translate"
action = "translate"

[[layout]]
component = "preview"
bind = "translated_text"

[[actions]]
name = "translate"
kind = "skill"
actor = "translator"
skill = "translate"
arguments = { source_text = "{{source_text}}", target_language = "{{target_lang}}" }
output = "translated_text"

[permissions]
provider_calls = true
`;

describe('App validator', () => {
  it('accepts a global App with an explicit actor', () => {
    const result = validateAppToml(VALID_TRANSLATOR);
    expect(result.errors).toEqual([]);
    expect(result.definition).toMatchObject({
      schema: 'marifold.app.v0',
      app: { name: 'translator' },
      actors: [{ name: 'translator', profile: 'app_tester' }],
      execution: {
        think: false,
        memory: false,
        profileContext: false,
      },
    });
  });

  it('rejects invalid TOML, old schema ids, and Agent transcript history', () => {
    expect(validateAppToml('not toml [').ok).toBe(false);
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'marifold.app.v0',
      'marifold.skillapp.v0',
    )).errors[0]).toContain('schema must be');
    expect(validateAppToml(`${VALID_TRANSLATOR}\n[execution]\nhistory = true\n`)
      .errors.join('\n')).toContain('never use Agent transcripts');
  });

  it('validates actor names and requires every action to reference one', () => {
    const missing = validateAppToml(VALID_TRANSLATOR.replace('actor = "translator"', 'actor = "postman"'));
    expect(missing.errors.join('\n')).toContain('must reference a declared actor');

    const duplicate = validateAppToml(VALID_TRANSLATOR.replace(
      '[[variables]]',
      '[[actors]]\nname = "translator"\nprofile = "postman"\n\n[[variables]]',
    ));
    expect(duplicate.errors.join('\n')).toContain("Duplicate actor name 'translator'");

    const multiActor = validateAppToml(VALID_TRANSLATOR.replace(
      '[[variables]]',
      '[[actors]]\nname = "postman"\nprofile = "postman"\n\n[[variables]]',
    ));
    expect(multiActor.errors).toEqual([]);
    expect(multiActor.definition?.actors).toHaveLength(2);
  });

  it('only admits chat-skill actions in v0 and enforces provider permission', () => {
    const tool = validateAppToml(VALID_TRANSLATOR.replace('kind = "skill"', 'kind = "tool"'));
    expect(tool.errors.join('\n')).toContain('kind must be skill');

    const noProvider = validateAppToml(VALID_TRANSLATOR.replace(
      'provider_calls = true',
      'provider_calls = false',
    ));
    expect(noProvider.errors.join('\n')).toContain('provider_calls = true');
  });

  it('rejects unknown components, broken binds, and unknown action references', () => {
    const result = validateAppToml(VALID_TRANSLATOR
      .replace('component = "textarea"', 'component = "iframe"')
      .replace('bind = "translated_text"', 'bind = "missing_var"')
      .replace('action = "translate"', 'action = "missing_action"'));
    expect(result.errors.join('\n')).toContain('component must be one of');
    expect(result.errors.join('\n')).toContain("unknown variable 'missing_var'");
    expect(result.errors.join('\n')).toContain('button');
  });

  it('validates variables, templates, output ownership, and versions', () => {
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      '{{source_text}}',
      '{{nonexistent}}',
    )).errors.join('\n')).toContain("unknown variable '{{nonexistent}}'");
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'output = "translated_text"',
      'output = "source_text"',
    )).errors.join('\n')).toContain('output or state variable');
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'options = ["English", "Japanese"]',
      '',
    )).errors.join('\n')).toContain('options must be a non-empty string array');
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'default = "English"',
      'default = "Klingon"',
    )).errors.join('\n')).toContain('default does not match');
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'description = "Translate text."',
      'description = "Translate text."\nversion = "v1.0.0"',
    )).errors.join('\n')).toContain('Semantic Versioning');
  });

  it('accepts one tab level, rejects nested tabs, and protects output controls', () => {
    const tabs = `
schema = "marifold.app.v0"

[app]
name = "tabbed"
title = "Tabbed"

[[variables]]
name = "out"
type = "string"
role = "output"

[[layout]]
component = "tabs"
tabs = [
  [ { component = "preview", bind = "out" } ],
]
`;
    expect(validateAppToml(tabs).errors).toEqual([]);
    expect(validateAppToml(tabs.replace(
      '{ component = "preview", bind = "out" }',
      '{ component = "tabs", tabs = [] }',
    )).errors.join('\n')).toContain('cannot be nested');
    expect(validateAppToml(VALID_TRANSLATOR.replace(
      'component = "preview"\nbind = "translated_text"',
      'component = "textarea"\nbind = "translated_text"',
    )).errors.join('\n')).toContain('cannot edit output variable');
  });

  it('validates the portable translator App bundle', () => {
    const source = fixtureSource();
    const result = validateAppToml(source);
    expect(result.errors).toEqual([]);
    expect(result.definition?.app).toMatchObject({ name: 'translator', version: '1.0.0' });
    expect(result.definition?.actors).toEqual([{ name: 'translator', profile: 'app_tester' }]);
    expect(result.definition?.layout[1]).toMatchObject({
      component: 'row',
      responsive: 'stack',
      children: [
        { component: 'textarea', bind: 'source_text' },
        { component: 'preview', bind: 'translated_text' },
      ],
    });
  });

  it('loads global App bundles and resolves an actor Skill from typed state', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-app-'));
    tempDirs.push(directory);
    const bundle = path.join(directory, 'translator');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'app.toml'), fixtureSource());

    const store = new AppStore(directory);
    const app = store.require('translator');
    expect(store.list().map(candidate => candidate.app.name)).toEqual(['translator']);

    const skill = parseSkill(fs.readFileSync(
      path.resolve(process.cwd(), '../../examples/profiles/app_tester/skills/translate/SKILL.md'),
      'utf-8',
    ));
    const action = resolveAppAction(app, 'translate', {
      source_text: 'Good morning',
      target_language: 'Japanese',
    }, skill);
    expect(action.profile).toBe('app_tester');
    expect(action.actorName).toBe('translator');
    expect(action.instructions[0]).toContain('Translate the following text into Japanese.');
    expect(action.instructions[0]).toContain('Good morning');
    expect(action.output).toBe('translated_text');
    expect(action.mode).toBe('chat');
  });

  it('rejects renderer attempts to write output variables or inject Skill arguments', () => {
    const result = validateAppToml(VALID_TRANSLATOR.replace(
      'target_language = "{{target_lang}}"',
      'injected = "{{target_lang}}"',
    ));
    expect(result.definition).toBeDefined();
    const skill = parseSkill(
      '---\nname: translate\nvariables:\n  - name: source_text\n    required: true\n---\n{{source_text}}\n',
    );
    expect(() => resolveAppAction(
      result.definition!,
      'translate',
      { source_text: 'Hello', target_lang: 'English', translated_text: 'forged' },
      skill,
    )).toThrow(/read-only variable/);
    expect(() => resolveAppAction(
      result.definition!,
      'translate',
      { source_text: 'Hello', target_lang: 'English' },
      skill,
    )).toThrow(/unknown skill variable 'injected'/);
  });

  it('normalizes hidden form labels and rejects them on non-form components', () => {
    const hidden = validateAppToml(VALID_TRANSLATOR.replace(
      'component = "select"\nbind = "target_lang"',
      'component = "select"\nbind = "target_lang"\nshow_label = false',
    ));
    expect(hidden.errors).toEqual([]);
    expect(hidden.definition?.layout[0]).toMatchObject({ showLabel: false });

    const invalid = validateAppToml(VALID_TRANSLATOR.replace(
      'component = "button"\nlabel = "Translate"',
      'component = "button"\nlabel = "Translate"\nshow_label = false',
    ));
    expect(invalid.errors.join('\n')).toContain('show_label is only allowed');
  });
});

function fixtureSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), '../../examples/apps/translator/app.toml'),
    'utf-8',
  );
}
