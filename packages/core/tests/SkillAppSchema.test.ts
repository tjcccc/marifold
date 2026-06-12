import { describe, expect, it } from 'vitest';
import { validateSkillAppToml } from '../src/skillapp/SkillAppValidator';

const VALID_TRANSLATOR = `
schema = "marifold.skillapp.v0"

[app]
name = "translator"
title = "Translator"
description = "Translate text."

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
kind = "profile"
profile = "translator"
prompt = "Translate to {{target_lang}}: {{source_text}}"
output = "translated_text"

[permissions]
provider_calls = true
`;

describe('SkillApp validator', () => {
  it('accepts a valid translator definition', () => {
    const result = validateSkillAppToml(VALID_TRANSLATOR);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.definition?.app.name).toBe('translator');
    expect(result.definition?.variables).toHaveLength(3);
    expect(result.definition?.permissions.files).toBe('none');
  });

  it('rejects invalid TOML and wrong schema ids', () => {
    expect(validateSkillAppToml('not toml [').ok).toBe(false);
    const wrongSchema = validateSkillAppToml(VALID_TRANSLATOR.replace('marifold.skillapp.v0', 'marifold.skillapp.v9'));
    expect(wrongSchema.ok).toBe(false);
    expect(wrongSchema.errors[0]).toContain('schema must be');
  });

  it('rejects unknown components, broken binds, and unknown action references', () => {
    const result = validateSkillAppToml(VALID_TRANSLATOR
      .replace('component = "textarea"', 'component = "iframe"')
      .replace('bind = "translated_text"', 'bind = "missing_var"')
      .replace('action = "translate"', 'action = "missing_action"'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('component must be one of');
    expect(result.errors.join('\n')).toContain("unknown variable 'missing_var'");
    expect(result.errors.join('\n')).toContain('button');
  });

  it('rejects prompts referencing undeclared variables', () => {
    const result = validateSkillAppToml(VALID_TRANSLATOR.replace('{{source_text}}', '{{nonexistent}}'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain("unknown variable '{{nonexistent}}'");
  });

  it('rejects actions writing to input variables', () => {
    const result = validateSkillAppToml(VALID_TRANSLATOR.replace('output = "translated_text"', 'output = "source_text"'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('output or state variable');
  });

  it('enforces permission gates for tools and provider calls', () => {
    const shellTool = `
schema = "marifold.skillapp.v0"

[app]
name = "runner"
title = "Runner"

[[variables]]
name = "result"
type = "string"
role = "output"

[[layout]]
component = "preview"
bind = "result"

[[actions]]
name = "run"
kind = "tool"
tool = "shell_exec"
input = { command = "ls" }
output = "result"
`;
    const denied = validateSkillAppToml(shellTool);
    expect(denied.ok).toBe(false);
    expect(denied.errors.join('\n')).toContain("tool 'shell_exec' without the required permission");

    const allowed = validateSkillAppToml(`${shellTool}\n[permissions]\nshell = true\n`);
    expect(allowed.errors).toEqual([]);

    const noProvider = validateSkillAppToml(VALID_TRANSLATOR.replace('provider_calls = true', 'provider_calls = false'));
    expect(noProvider.ok).toBe(false);
    expect(noProvider.errors.join('\n')).toContain('provider_calls = true');
  });

  it('requires enum options exactly for enum variables and validates defaults', () => {
    const noOptions = validateSkillAppToml(VALID_TRANSLATOR.replace('options = ["English", "Japanese"]', ''));
    expect(noOptions.ok).toBe(false);
    expect(noOptions.errors.join('\n')).toContain('options must be a non-empty string array');

    const badDefault = validateSkillAppToml(VALID_TRANSLATOR.replace('default = "English"', 'default = "Klingon"'));
    expect(badDefault.ok).toBe(false);
    expect(badDefault.errors.join('\n')).toContain('default does not match');
  });

  it('rejects nested tabs and accepts one level', () => {
    const tabs = `
schema = "marifold.skillapp.v0"

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
    const result = validateSkillAppToml(tabs);
    expect(result.errors).toEqual([]);
    expect(result.definition?.layout[0].tabs?.[0]?.[0]).toMatchObject({ component: 'preview', bind: 'out' });

    const nested = validateSkillAppToml(tabs.replace(
      '{ component = "preview", bind = "out" }',
      '{ component = "tabs", tabs = [] }',
    ));
    expect(nested.ok).toBe(false);
    expect(nested.errors.join('\n')).toContain('cannot be nested');
  });
});
