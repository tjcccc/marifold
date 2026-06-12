# SkillApp Schema Specification (marifold.skillapp.v0)

SkillApps are schema-defined GUI mini apps for focused, repeatable tasks — translators, UI design helpers, research helpers, prompt generators. A SkillApp is a declarative TOML file; Marifold owns rendering, validation, permissions, state, and provider calls. Definitions never run arbitrary code.

This document is the v0 schema contract. v0 ships **spec and validator only** — no runtime or renderer exists yet. The schema is the cross-client contract for the future TUI, Web UI, and Apple clients, so it stabilizes first. The validator lives in `packages/core/src/skillapp`.

## Status and non-goals

- No arbitrary code execution, no custom components, no remote definition loading.
- No runtime, rendering, or state engine in v0 — definitions can be authored and validated only.
- `workflow` actions are reserved for the future workflow runtime and rejected by the v0 validator.

## File shape

A SkillApp is one TOML file, conventionally `<name>.skillapp.toml`, either standalone or inside a profile directory under `skillapps/`.

```toml
schema = "marifold.skillapp.v0"

[app]
name = "translator"            # kebab-case identifier, unique per workspace
title = "Translator"
description = "Translate text between languages."

[[variables]]
name = "source_text"           # snake_case identifier, unique within the app
type = "string"                # string | number | boolean | enum
role = "input"                 # input | output | state
label = "Text to translate"

[[layout]]
component = "textarea"
bind = "source_text"

[[actions]]
name = "translate"
kind = "profile"               # model | profile | tool
profile = "translator"
prompt = "Translate the following text from {{source_lang}} to {{target_lang}}:\n\n{{source_text}}"
output = "translated_text"

[permissions]
provider_calls = true
files = "none"
shell = false
network = false
export = true
```

## `[app]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Kebab-case (`[a-z0-9-]+`). Identifier for storage and CLI. |
| `title` | string | yes | Display title. |
| `description` | string | no | One-line description. |

## `[[variables]]`

Typed state shared between layout and actions.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Snake_case (`[a-z0-9_]+`), unique within the app. |
| `type` | string | yes | `string`, `number`, `boolean`, or `enum`. |
| `role` | string | yes | `input` (user-editable), `output` (action-written), or `state` (internal). |
| `label` | string | no | Display label. |
| `default` | matches type | no | Initial value. |
| `options` | string[] | `enum` only | Allowed values; required and non-empty for `enum`, forbidden otherwise. |

## `[[layout]]`

A flat ordered list of components (v0 has no nesting except `tabs`). The component set is closed:

| Component | Binds | Notes |
|---|---|---|
| `text` | — | Static text; requires `content`. |
| `text_input` | variable | Single-line input; `bind` must reference a `string`/`number` variable. |
| `textarea` | variable | Multi-line input. |
| `select` | variable | `bind` must reference an `enum` variable. |
| `preview` | variable | Read-only rendering of a variable (markdown/text/html per `format`). |
| `tabs` | — | Requires `tabs = [...]` of layout item arrays (one level deep only). |
| `file_picker` | variable | Writes the picked path/content into `bind`; requires `permissions.files != "none"`. |
| `button` | — | Requires `action` referencing an action name. |
| `download_button` | variable | Exports a variable's content; requires `permissions.export = true`. |

Common fields: `component` (required), `bind`, `label`, `action`, `content`, `format`, `tabs`.

## `[[actions]]`

Declarative calls. Every action writes its result into the `output` variable.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Snake_case, unique within the app. |
| `kind` | string | yes | `model` (default provider/model), `profile` (named profile), or `tool` (built-in agent tool). |
| `profile` | string | `profile` kind | Target profile name (resolved at runtime). |
| `tool` | string | `tool` kind | Built-in tool name (`read_file`, `write_file`, `shell_exec`, `web_search`, `ask_profile`). |
| `prompt` | string | `model`/`profile` kinds | Template; `{{variable}}` placeholders must reference declared variables. |
| `input` | table | `tool` kind | Tool arguments; string values may use `{{variable}}` templates. |
| `output` | string | yes | Output/state variable that receives the result. |

## `[permissions]`

Explicit grants, aligned with the agent approval vocabulary so the future runtime reuses the same enforcement layer (`ToolKind` / `ApprovalMode` in `packages/core/src/agent/ApprovalPolicy.ts`).

| Field | Type | Default | Gates |
|---|---|---|---|
| `provider_calls` | boolean | `true` | `model`/`profile` actions. |
| `files` | string | `"none"` | `"none"`, `"read"`, `"write"` — `file_picker`, `read_file`/`write_file` tools. |
| `shell` | boolean | `false` | `shell_exec` tool actions. |
| `network` | boolean | `false` | `web_search` tool actions. |
| `export` | boolean | `true` | `download_button`. |

The validator rejects definitions whose layout or actions exceed their declared permissions. At runtime, permissions will additionally be subject to the user's `[agent.approval]` policy — a SkillApp can never grant itself more than the user allows.

## Validation rules (v0 validator)

1. `schema` must equal `marifold.skillapp.v0`.
2. `app.name` kebab-case; variable and action names snake_case and unique.
3. Variable types/roles from the closed sets; `options` exactly for `enum`.
4. Layout components from the closed set; `bind`/`action` references must resolve; component/permission gates hold.
5. Action kinds from the closed set; `output` must reference an `output` or `state` variable; `{{...}}` placeholders must reference declared variables.
6. Tool actions must name a known built-in tool and satisfy permission gates.

## Worked example: translator

```toml
schema = "marifold.skillapp.v0"

[app]
name = "translator"
title = "Translator"
description = "Translate text between languages with a dedicated profile."

[[variables]]
name = "source_lang"
type = "enum"
role = "input"
label = "From"
default = "auto"
options = ["auto", "English", "Japanese", "Chinese"]

[[variables]]
name = "target_lang"
type = "enum"
role = "input"
label = "To"
default = "English"
options = ["English", "Japanese", "Chinese"]

[[variables]]
name = "source_text"
type = "string"
role = "input"
label = "Text"

[[variables]]
name = "translated_text"
type = "string"
role = "output"
label = "Translation"

[[layout]]
component = "select"
bind = "source_lang"

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

[[layout]]
component = "download_button"
bind = "translated_text"
label = "Save translation"

[[actions]]
name = "translate"
kind = "profile"
profile = "translator"
prompt = "Translate the following text from {{source_lang}} to {{target_lang}}. Reply with the translation only.\n\n{{source_text}}"
output = "translated_text"

[permissions]
provider_calls = true
files = "none"
shell = false
network = false
export = true
```

## Worked example: image prompt builder

```toml
schema = "marifold.skillapp.v0"

[app]
name = "image-prompt"
title = "Image Prompt Builder"
description = "Turn a rough idea into a structured image generation prompt."

[[variables]]
name = "idea"
type = "string"
role = "input"
label = "Rough idea"

[[variables]]
name = "style"
type = "enum"
role = "input"
label = "Style"
default = "photorealistic"
options = ["photorealistic", "illustration", "watercolor", "3d-render"]

[[variables]]
name = "generated_prompt"
type = "string"
role = "output"
label = "Generated prompt"

[[layout]]
component = "text_input"
bind = "idea"

[[layout]]
component = "select"
bind = "style"

[[layout]]
component = "button"
label = "Generate"
action = "generate"

[[layout]]
component = "preview"
bind = "generated_prompt"
format = "markdown"

[[actions]]
name = "generate"
kind = "model"
prompt = "Write a detailed English image-generation prompt in the {{style}} style for this idea: {{idea}}. Reply with the prompt only."
output = "generated_prompt"

[permissions]
provider_calls = true
files = "none"
shell = false
network = false
export = true
```
