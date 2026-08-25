# SkillApp Specification (`marifold.skillapp.v1`)

SkillApps are declarative, local GUI templates for one focused model-backed
job. Their core operation is deliberately narrow:

> Bind user parameters to one app-local Skill, run that Skill with one
> explicitly registered model, normalize the response, and bind it to output
> state.

`skillapp.ts` is an authoring format, not an application runtime. marifold
statically inspects its TypeScript syntax and compiles it to renderer-neutral
JSON. It never imports or executes the file. The Web UI renders that JSON now;
a macOS client can render the same component and state contract with SwiftUI
without parsing TypeScript.

## Bundle layout

SkillApps remain global rather than profile-owned:

```text
~/.marifold/apps/
  translator/
    skillapp.ts
    skills/
      translate/
        SKILL.md
```

`[paths].apps_dir` overrides the default `~/.marifold/apps`. The bundle folder
and `app.name` must match and use kebab-case.

`registerSkill("translate", ...)` resolves exactly
`<bundle>/skills/translate/SKILL.md`. There is no profile/global fallback, and
the resolved file must remain inside the bundle after symbolic links are
resolved. The folder name and the Skill frontmatter `name` must match.

## Complete translator

The repository example is
[`examples/apps/translator/skillapp.ts`](../examples/apps/translator/skillapp.ts):

```ts
import {
  App,
  Button,
  Row,
  Select,
  Spacer,
  State,
  Textarea,
  TextResult,
  defineSkillApp,
  registerModel,
  registerSkill,
  trigger,
  useSkill,
} from '@marifold/core';

const targetLanguages = [
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'French',
  'German',
  'Spanish',
] as const;

const source = State('');
const targetLanguage = State('English');
const result = State('');

const translationModel = registerModel(
  'ollama/maternion/hy-mt2:1.8b',
  { think: false },
);

const translationSkill = registerSkill('translate', {
  result: TextResult({ trim: true }),
});

const translate = useSkill(translationModel, translationSkill, {
  parameters: {
    source_text: source,
    target_language: targetLanguage,
  },
  output: result,
  memory: false,
  history: false,
  profileContext: false,
});

trigger(translate, {
  onChange: [source, targetLanguage],
  debounce: 1_000,
  concurrency: 'latest',
});

export default defineSkillApp({
  app: {
    name: 'translator',
    title: 'marifold Translation',
    version: '1.0.0',
    description: 'Translate text with a dedicated local model.',
  },
  ui: App([
    Row([
      Select('Translate to', targetLanguage, {
        options: targetLanguages,
        grow: true,
      }),
    ]),
    Row([
      Textarea('Input', source, {
        grow: true,
        placeholder: 'Enter text to translate',
      }),
      Textarea('Result', result, {
        grow: true,
        editable: false,
        copyable: true,
      }),
    ], {
      gap: 'large',
      responsive: 'stack',
    }),
    Row([
      Spacer(),
      Button('Translate', {
        trigger: translate,
        emphasis: 'primary',
      }),
      Spacer(),
    ]),
  ]),
});
```

Its Skill declares `source_text` and `target_language`; operation parameter
keys intentionally match those Skill variable names. State names are local to
the template and may use normal TypeScript camelCase.

## Restricted TypeScript

The `.ts` extension provides familiar syntax, editor completion, and type
checking. It does not make SkillApp a general front-end framework. The static
compiler accepts only:

- named builder imports from `@marifold/core`;
- top-level `const` declarations made from literals, arrays, objects,
  references, and approved builder calls;
- top-level declarative `trigger(...)` registrations;
- one `export default defineSkillApp(...)` declaration.

Functions, callbacks, classes, loops, conditions, property access, dynamic
imports, arbitrary packages, object/array spreads, mutation, and side effects
are rejected. Consequently there is no `watch()` callback, `computed()`, local
reducer, network call, or access to `State.value`. Stateful non-model software
such as a todo manager belongs in a normal application rather than SkillApp.

## State and binding

`State(initial)` declares string state and gives it the surrounding `const`
name. Components bind to the state reference; the template never reads or
writes it directly.

When a renderer opens a v1 SkillApp, the service creates an ephemeral instance
with the declared initial values. User edits are validated and stored there.
States used as an operation output are read-only to clients. A successful
operation replaces its bound output state, causing every renderer component
bound to that state to refresh.

Required inputs are derived from required, default-less variables in the
operation's `SKILL.md`. When any such bound state is empty or whitespace,
marifold treats the operation as not ready: it cancels pending work, clears the
bound output, returns an idle mutation with
`reason: "missing_required_input"`, and disables buttons for that operation.
This is ordinary form state, not a warning or error.

v1 intentionally supports string state only. Lists, structured results,
append/replace list policies, and computed state can be added later without
introducing arbitrary template code.

## Models, Skills, and operations

`registerModel("provider/model", options)` splits on the first slash. The
provider must already exist in marifold configuration; the remainder is passed
as the provider's model ID, so model IDs may contain additional slashes.

v1 model options contain `think` only. `memory`, `history`, and
`profileContext` belong to `useSkill` execution policy and must all be `false`.
The run is genuinely profile-free: it creates no Agent session or transcript,
loads no profile or memory, and exposes no chat/agent tools.

`registerSkill(name, { result })` registers an app-local Skill. The Skill's
`SKILL.md` remains the authoritative prompt, so v1 has no inline prompt or
prompt override.

`useSkill(model, skill, options)` declares an operation. It is not an async
function and cannot be called from template code. It binds:

- Skill parameter names to input states;
- one output state;
- the fixed profile-free execution policy.

## Triggers

A button binds directly to an operation:

```ts
Button('Translate', { trigger: translate });
```

An automatic trigger is declarative:

```ts
trigger(translate, {
  onChange: [source, targetLanguage],
  debounce: 1_000,
  concurrency: 'latest',
});
```

`debounce` is milliseconds, defaults to `0`, and is capped at 60 seconds. v1 concurrency is always
`latest`: a new matching change cancels a pending timer or in-flight provider
request for the same operation, and a stale result cannot overwrite newer
state. Manual and automatic triggers use the same operation path.

Each trigger runs exactly one Skill with one model. SkillApp does not support
operation chaining, branching, loops, local actions, or effectful tools.

## Structured result contract

Renderers never consume raw model output. `TextResult({ trim: true })` asks the
runtime adapter to trim the completed provider text and normalize it as:

```json
{
  "status": "ok",
  "data": {
    "text": "Good morning."
  },
  "meta": {
    "engine": "ollama",
    "model": "maternion/hy-mt2:1.8b",
    "durationMs": 830,
    "usage": {
      "totalTokens": 44
    }
  }
}
```

Failures use the same envelope:

```json
{
  "status": "error",
  "error": {
    "code": "PROVIDER_ERROR",
    "message": "..."
  }
}
```

The model is not required to emit JSON or XML tags. A future result adapter can
normalize JSON, lists, files, or images while preserving this outer contract.

## Components

SkillApp components are semantic, form-oriented controls with marifold-owned
appearance. They do not accept HTML, CSS, classes, arbitrary styles, or event
callbacks.

v1 supports:

- layout: `App`, `Row`, `Column`, `Spacer`;
- form: `Textarea(label, state, options)` and
  `Select(label, state, { options, ... })`;
- action: `Button(label, { trigger, emphasis })`.

Form components always require a non-empty label. `showLabel: false` hides the
visual label without reserving layout space while retaining an accessible
label for native renderers. Supported controlled presentation options include
`grow`, `gap`, `responsive: "stack"`, `placeholder`, `editable`, `copyable`,
and button `emphasis`.

The renderer owns app chrome rather than the template. The Web renderer keeps
the app version and an **Activity** control in a footer fixed to the bottom of
the App workspace. Activity opens a bottom drawer for completed runs, genuine
warnings and errors, response time, and token usage. Expected idle states such
as a missing required input do not create Activity entries. Native renderers
should preserve the same distinction even when their chrome differs.

## Service and native-renderer contract

Catalog routes return normalized `marifold.skillapp.v1` definitions:

| Route | Purpose |
| --- | --- |
| `GET /v1/apps` | List normalized definitions |
| `GET /v1/apps/:name` | Read one normalized definition |
| `POST /v1/apps/:name/instances` | Create ephemeral v1 state |
| `PATCH /v1/app-instances/:id/state` | Apply user state and matching automatic triggers |
| `POST /v1/app-instances/:id/operations/:operation` | Run a button-bound operation |
| `DELETE /v1/app-instances/:id` | Cancel work and release the instance |

The instance mutation response contains `status` (`idle`, `completed`, or
`superseded`), the complete state snapshot, and optional `operation`, `reason`,
and structured Skill result fields. This JSON is the middle layer shared by
Web, SwiftUI, and other future renderers. Idle instances expire after 30
minutes; renderers should also delete them when their App view closes.
