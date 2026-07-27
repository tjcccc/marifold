# App Schema Specification (`marifold.app.v0`)

Apps are declarative, local GUI bundles for focused jobs such as translation,
email preparation, research, and design assistance. An App can name multiple
profile actors, and each action explicitly chooses the actor whose Skill runs.
The currently selected Agent profile is never implicit App state.

Marifold validates each `app.toml` on the service host and returns normalized
JSON to renderers. Clients submit typed variable values only; they cannot
replace actor profiles, Skills, prompts, permissions, or execution controls.

## Storage

Apps are global rather than profile-owned:

```text
~/.marifold/apps/
  translator/
    app.toml
    assets/
      ...
```

`[paths].apps_dir` can override the default `~/.marifold/apps`. The bundle
directory and `[app].name` must match and use kebab-case. Additional bundle
files such as `assets/` are kept beside `app.toml` so future renderers and the
planned `$app-creator` Skill can treat an App as one portable folder.

The former profile-scoped `skillapps/*.skillapp.toml` prototype is not part of
this schema and is not loaded.

## Complete example

```toml
schema = "marifold.app.v0"

[app]
name = "translator"
title = "Marifold Translation"
version = "1.0.0"
description = "Translate focused text."

[[actors]]
name = "translator"
profile = "app_tester"

[[variables]]
name = "source_text"
type = "string"
role = "input"
label = "Source text"
required = true

[[variables]]
name = "target_language"
type = "enum"
role = "input"
label = "Translate to"
default = "English"
options = ["Chinese", "English", "Japanese"]

[[variables]]
name = "translated_text"
type = "string"
role = "output"
label = "Translation"

[[layout]]
component = "row"
children = [
  { component = "select", bind = "target_language", grow = true },
]

[[layout]]
component = "row"
gap = "large"
responsive = "stack"
children = [
  { component = "textarea", bind = "source_text", grow = true },
  { component = "preview", bind = "translated_text", format = "markdown", grow = true },
]

[[layout]]
component = "row"
children = [
  { component = "spacer" },
  { component = "button", action = "translate", label = "Translate" },
  { component = "spacer" },
]

[[actions]]
name = "translate"
kind = "skill"
actor = "translator"
skill = "translate"
arguments = {
  source_text = "{{source_text}}",
  target_language = "{{target_language}}",
}
output = "translated_text"

[execution]
think = false
memory = false
profile_context = false

[permissions]
provider_calls = true
files = "none"
shell = false
network = false
export = false
```

The repository fixture lives at
`examples/apps/translator/app.toml`; its actor Skill remains under
`examples/profiles/app_tester/skills/translate/SKILL.md`.

## Actors

Each `[[actors]]` entry has:

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | App-local snake_case actor identifier |
| `profile` | yes | Marifold profile resolved when an action runs |
| `label` | no | Human-readable actor label |

Multiple actors can use different providers, models, instructions, memories,
and Skills. Missing profiles or Skills do not hide the App from the catalog;
the affected action fails with the profile or Skill error when invoked.

## Variables

Variables use a snake_case `name`, a `type` (`string`, `number`, `boolean`, or
`enum`), and a `role` (`input`, `output`, or `state`). Optional fields are
`label`, `required`, `default`, and `options` for enums.

Renderers may submit input and state variables. Output variables are
server-owned action results and cannot be forged by the client.

## Layout

The portable v0 layout components are:

- Containers: `row`, `column`, `tabs`
- Content: `text`, `spacer`, `preview`
- Inputs: `text_input`, `textarea`, `select`, `file_picker`
- Actions: `button`, `download_button`

`row` and `column` use `children`; `tabs` uses a two-dimensional `tabs` array.
Layout depth is capped at four, tabs cannot nest, and a definition may contain
at most 100 layout items. Supported presentation fields include `label`,
`show_label`, `gap`, `grow`, `responsive = "stack"`, and preview
`format = "text" | "markdown"`.

## Actions

v0 supports only server-owned Skill actions:

```toml
[[actions]]
name = "polish"
kind = "skill"
actor = "optimizer"
skill = "email-polisher"
arguments = { draft = "{{draft}}" }
output = "polished_draft"
```

Action arguments may contain typed literals and `{{variable}}` placeholders.
The server resolves the declared actor profile and then resolves that profile's
Skill with the normal profile-over-global precedence.

Only chat-mode Skills run in App v0. Agent-mode or other effectful actions are
rejected until Apps have their own approval-aware run contract. In particular,
a future Postman actor cannot silently send email through this chat action
endpoint.

## Execution and history

| Key | Default | Meaning |
| --- | --- | --- |
| `think` | `false` | Enable the actor profile's provider thinking mode |
| `memory` | `false` | Inject actor profile memory |
| `profile_context` | `false` | Inject actor PROFILE/RULES/CUSTOM context |

App actions never replay or write Agent sessions. There is deliberately no
`history` field in `marifold.app.v0`; App-specific audit history can be added
later without polluting Agent transcripts.

## Permissions

`provider_calls` gates Skill actions. `files`, `shell`, `network`, and `export`
remain explicit capability declarations for portable components and future
approval-aware actions. Defaults are provider calls allowed, files/network/
shell denied, and export allowed. A declaration never bypasses Marifold's
runtime approval boundary.
