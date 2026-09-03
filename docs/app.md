# SkillApp Specification (`marifold.skillapp.v1` and `.v2`)

SkillApps are declarative, local GUI templates for one focused model-backed
job. Their core operation is deliberately narrow:

> Bind user input to one Skill, run that Skill with either an explicitly
> registered model or a registered profile, normalize the response, and bind
> it to output state.

`marifold.skillapp.v1` remains the profile-free app-local contract.
`marifold.skillapp.v2` is selected automatically when a template uses
`registerProfile()` and `useProfileSkill()`.

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

A v2 profile reference does not copy Skills into the App bundle. It resolves
the selected profile's effective Skill catalog at load and run time, including
the normal profile-over-global shadowing rule. The profile and App remain
separate global resources.

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

## Profile-backed SkillApp

The repository example
[`examples/apps/painers-room/skillapp.ts`](../examples/apps/painers-room/skillapp.ts)
uses the installed `painter` profile without duplicating its prompt-making
Skills. The essential form is:

```ts
const idea = State('');
const result = State('');
const references = AttachmentState();
const promptMakers = [
  { label: 'GPT Image', value: 'make-gpt-image-prompt' },
  { label: 'Midjourney', value: 'make-midjourney-prompt' },
] as const;
const promptMaker = State('make-gpt-image-prompt');

const painter = registerProfile('painter', {
  memory: false,
  history: false,
});

const makePrompt = useProfileSkill(painter, promptMaker, {
  skills: promptMakers,
  input: idea,
  attachments: references,
  stripSkillName: true,
  output: result,
  result: TextResult({ trim: true }),
});
```

`input` is the ordinary user prompt seen by the Skill. It is useful for Skills
such as prompt makers that intentionally declare no template variables.
`stripSkillName: true` removes one pasted leading allowlisted Skill invocation
(with or without `$`) from that input; it does not remove ordinary mentions
later in the text.
`attachments` binds one `AttachmentState()` slot. Its uploads are staged
read-only for the operation and remain outside the model prompt until the
Agent uses the attachment inspection tools. Images and ordinary files share
the same slot; non-image attachments require the registered profile to run in
Agent mode.
`parameters` remains available for Skills with named `{{variables}}`:

```ts
const translate = useProfileSkill(friend, 'translate', {
  parameters: {
    source_text: source,
    target_language: targetLanguage,
  },
  output: result,
  result: TextResult({ trim: true }),
});
```

## Interactive operations and the built-in builder

Long-running Agent Skills may pause for model-authored questions or a write
approval. This lifecycle belongs to the service runtime, not to executable
template code. A template opts one fixed profile Agent Skill into it with
`interactive: true`:

```ts
const idea = State('');
const result = State('');
const references = AttachmentState();
const maker = registerProfile('default', {
  memory: false,
  history: false,
});

const build = useProfileSkill(maker, 'skillapp-builder', {
  input: idea,
  attachments: references,
  output: result,
  result: TextResult({ trim: true }),
  interactive: true,
});
```

Interactive operations must use a fixed Skill rather than a state-selected
Skill, must resolve to Agent mode, and may be started only by a button. They
cannot use `trigger(...)`. One interactive execution is exclusive within an
App instance. Its renderer-neutral `instance.execution` snapshot moves through
`running`, `waiting_for_input`, `waiting_for_approval`, and one terminal phase.
While it is active, renderers disable the ordinary App interface as a single
global operation state; question, approval, and cancel controls remain active.
No component-level state binding or `async` function exists in `skillapp.ts`.

The Web renderer presents the existing single- and multiple-question sheets
inside the App, polls the service-owned snapshot, and can reconnect to an
active browser-session instance after a reload. Approval offers only **Allow
once** or **Deny** because an App cannot create a persistent grant.

`skillapp-builder` is a protected built-in Agent Skill. Users may invoke it as
`$skillapp-builder ...` or simply ask an Agent to make or update a SkillApp;
the runtime lazily attaches the same path-aware builder guide. It first
inspects the current App contract, configured App directory, existing Apps,
profiles, and each profile's effective Skills. It helps turn a rough idea into
fields, layout, and behavior, batches essential design questions, and then
submits a complete text bundle to one dedicated write tool. That tool requires
approval, confines paths to one kebab-case bundle, statically compiles and
validates the staged App, and installs it atomically. `create` refuses
collisions; `update` replaces the complete bundle and must have been explicitly
requested.
The inspection result includes exact builder signatures, bundle rules, and
canonical v1/v2 template skeletons; the built-in builder does not receive a
generic host-file reader when it has no bundled or explicitly permitted files.
This keeps it from probing existing App folders for examples. Builder runs use
at most eight model iterations, and three failed validation submissions block
further installation attempts in that run. A terminal failure reports the
iteration-cap reason and the most recent builder validation error when present.
Once installation commits, later cancellation or a provider failure cannot
roll it back; the execution reports the typed effect as its authoritative
success even if the Agent never finishes its prose explanation.

This is the one narrow effectful SkillApp path. Ordinary Apps still receive no
general write, shell, network, delegation, or dynamic permission capability.
Successful installation adds a typed `app_installed` effect to the operation
result. Renderers refresh the catalog while keeping the builder App open so its
final response and Activity result remain visible. The user can open the new
App from the refreshed catalog; the service rereads bundles and does not need
to restart.

The builder also receives the exact output-component signatures. It uses
`Markdown` when generated text should be read as rendered Markdown and may bind
`Download` to that same output state when the user wants a local file. The
download is renderer-owned; the Skill returns text and does not write a file or
invent a link.

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

When a renderer opens a SkillApp, the service creates an ephemeral instance
with the declared initial values. User edits are validated and stored there.
States used as an operation output are read-only to clients. A successful
operation replaces its bound output state, causing every renderer component
bound to that state to refresh.

Required inputs are derived from an explicit v2 `input` binding plus required,
default-less variables in the operation's `SKILL.md`. Changing an operation's
bound input, parameter, selected Skill, or attachments cancels pending work but
preserves a completed output for copying. The snapshot names that output in
`staleOutputs`, and renderers identify it as based on previous inputs until a
successful rerun replaces it. When a required state is empty or whitespace,
marifold also returns an idle mutation with `reason: "missing_required_input"`
and disables buttons for that operation. This is ordinary form state, not a
warning or error.

Ordinary `State` remains string-only. `AttachmentState()` is a separate,
bounded ephemeral resource binding whose snapshots expose filename, type, size,
and kind but never return uploaded base64 bytes. Lists, structured results,
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

`registerProfile(name, options)` declares a v2 profile reference. `name` is a
stable configured profile name. The options are:

- `model`: optional `provider/model` override for this App only. When omitted,
  the profile's model override falls back to the global default normally;
- `think`: optional App-only override, otherwise inherited normally;
- `memory`: defaults to `false`; when `true`, current profile memory is loaded
  read-only when that profile has memory enabled, and Agent output is never
  promoted into memory;
- `history`: defaults to `false`; when `true`, completed turns are retained
  only inside the current ephemeral App instance and profile reference. Normal
  profile conversations are never read or written.

`INSTRUCTIONS.md` always loads for a registered profile, with the read-only
legacy split-file fallback used when it has not been migrated yet. There is
intentionally no `profileContext: false` switch because that document is the
profile's identity. The Skill's declared mode is honored. A Skill without a
mode uses Agent execution.

`useProfileSkill(profile, skillNameOrState, options)` resolves the name through the
profile's ordinary installed profile/global catalog (excluding protected
built-in management Skills). It binds an optional `input` state,
optional named `parameters`, one output state, and a result adapter. String
skill names keep hyphenated names valid without allowing property access in the
restricted TypeScript grammar.

The second argument may instead be a `State` for a user-selected Skill. In that
form, `skills` is a required static allowlist and must exactly match the values
of a `Select` bound to that state. Every candidate Skill is resolved and its
bindings are validated when the App loads; a client cannot select any other
profile Skill by changing service state directly. Select choices may provide
separate renderer labels and values:

```ts
Select('Prompt maker', promptMaker, {
  options: promptMakers,
  grow: true,
});
```

Profile Skill bundles remain live rather than copied: every App load and run
re-resolves the profile/global Skill, and Agent-mode runs receive the selected
Skill directory through the existing narrow read-only run-workspace boundary.
This lets a Skill read files beside its SKILL.md while preventing writes to the
profile or global Skill directories.

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

`debounce` is milliseconds, defaults to `0`, and is capped at 60 seconds. Current concurrency is always
`latest`: a new matching change cancels a pending timer or in-flight provider
request for the same operation, and a stale result cannot overwrite newer
state. Manual and automatic non-interactive triggers use the same operation
path.

Each trigger runs exactly one Skill. SkillApp does not support operation
chaining, branching, loops, or local actions. The protected built-in builder
described above is the only App-specific persistent mutation boundary.

App execution does not inherit the profile's Agent permissions or trusted
folders. Ordinary Agent profile Skill operations expose attachment-scoped
`inspect_attachment`, `read_attachment`, and `search_attachment`, plus a
fail-closed `read_file`. Selected Skill bundles, the private run workspace, and
static App read declarations are the only readable host resources. Write,
shell, network, and delegation tools are not exposed except for the builder's
dedicated approve-once installation tool described above.

Static host reads belong directly in `skillapp.ts`:

```ts
export default defineSkillApp({
  app: { name: 'prompt-maker', title: 'Prompt maker' },
  permissions: [
    FileAccess('~/Prompts/shared-vars.toml', { access: 'read' }),
    FolderAccess('references', { access: 'read' }),
  ],
  ui: App([/* ... */]),
});
```

Relative paths resolve inside the App bundle; `~` and absolute paths resolve
on the service host. Declarations must already exist, symbolic links are
canonicalized, folder grants cannot target the filesystem root, the complete
user home, or Marifold private state, and only `access: "read"` is accepted.
An exact `FileAccess` does not make its parent directory or sibling files
readable. Permission paths stay server-side and are removed from catalog/detail
API definitions.

The attachment picker is an ephemeral per-instance upload grant, not a host
path selector and not a persistent permission. Dynamic filesystem grants and
general effectful tool declarations remain future work; they do not need a
second App configuration file.

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

The protected builder may additionally return a renderer-neutral typed effect:

```json
{
  "kind": "app_installed",
  "appName": "writing-studio",
  "title": "Writing Studio",
  "action": "created",
  "files": ["skillapp.ts"]
}
```

The model is not required to emit JSON or XML tags. A future result adapter can
normalize JSON, lists, files, or images while preserving this outer contract.
Natural-language warnings authored by a Skill currently remain ordinary text
results because the Skill contract has no typed warning marker. Renderers must
not guess warning severity from prose; an eventual structured result adapter
can route typed warnings to a separate state safely.

## Components

SkillApp components are semantic, form-oriented controls with marifold-owned
appearance. They do not accept HTML, CSS, classes, arbitrary styles, or event
callbacks.

Both schemas currently support:

- layout: `App`, `Row`, `Column`, `Spacer`;
- form: `Textarea(label, state, options)` and
  `Select(label, state, { options, ... })`;
- resource: `Attachments(label, attachmentState, options)`;
- output: `Markdown(label, state, options)` and
  `Download(label, state, { filename, ... })`;
- action: `Button(label, { trigger, emphasis })`.

Form components always require a non-empty label. `showLabel: false` hides the
visual label without reserving layout space while retaining an accessible
label for native renderers. Supported controlled presentation options include
`grow`, `gap`, `responsive: "stack"`, `placeholder`, `editable`, `copyable`,
and button `emphasis`. `Select` accepts either string choices or
`{ label, value }` choices. `Textarea` accepts `rows` (1–40) and `autoGrow`;
`Button({ alignToField: true })` aligns a full-height action with the input box
of an adjacent labeled field while collapsing to an ordinary action in a
responsive stacked row.
`Attachments` renders a rounded multi-file picker/drop target. Renderers show
image thumbnails plus ellipsized filenames, generic file chips for other
formats, and per-item removal. The Web renderer reuses the same file limits,
image optimization, and Office readable-view preparation as Agent chat.

`Markdown` is an explicit read-only presentation of a text state; renderers do
not guess the format from model prose. It is copyable and offers a
preview/source toggle by default. `copyable: false` or `sourceToggle: false`
removes either action, and `placeholder` controls its empty state.

`Download` serializes its bound text state in the renderer. Before that state
contains text, renderers show a neutral empty state instead of presenting the
declared filename as an existing file. It requires one static safe `filename`
without path separators and accepts optional
`mediaType`, `description`, `showLabel`, and `grow`. `mediaType` defaults to
`text/plain;charset=utf-8`; Markdown output should normally use
`text/markdown;charset=utf-8`. Multiple output components may bind the same
state, so an App can render an article with `Markdown` and download the exact
same value with `Download` without filesystem access:

```ts
Column([
  Markdown('Article preview', result),
  Download('Download article', result, {
    filename: 'short-article.md',
    mediaType: 'text/markdown;charset=utf-8',
  }),
])
```

Each `Download` represents one text file whose name is fixed by the template.
An App may declare several components for several static text downloads, with
each bound to the appropriate state. Per-run filenames, dynamic file
collections, and binary formats such as PDF, DOCX, ZIP, and PNG require a
future runtime-owned artifact contract and are not represented by `Download`.

The renderer owns app chrome rather than the template. The Web renderer keeps
the app version plus **Reset** and **Activity** controls in a footer fixed to the
bottom of the App workspace. Reset creates a fresh instance before releasing
the previous one, then clears form state, outputs, attachments, and Activity;
it is disabled during updates and operations. Activity opens a bottom drawer
for completed runs, genuine warnings and errors, response time, and token
usage. Expected idle states such as a missing required input do not create
Activity entries. Native renderers should preserve the same distinction even
when their chrome differs.

## Service and native-renderer contract

Catalog routes return normalized `marifold.skillapp.v1` or
`marifold.skillapp.v2` definitions:

| Route | Purpose |
| --- | --- |
| `GET /v1/apps` | List normalized definitions |
| `GET /v1/apps/:name` | Read one normalized definition |
| `POST /v1/apps/:name/instances` | Create ephemeral App state |
| `GET /v1/app-instances/:id` | Read current state and interactive execution snapshot |
| `PATCH /v1/app-instances/:id/state` | Apply user state and matching automatic triggers |
| `PUT /v1/app-instances/:id/attachments/:state` | Replace one attachment-state slot with bounded base64 uploads |
| `POST /v1/app-instances/:id/operations/:operation` | Run a button-bound operation |
| `POST /v1/app-instances/:id/executions/:executionId/input` | Resume a waiting run with normalized question answers |
| `POST /v1/app-instances/:id/executions/:executionId/approval` | Resume with `once` or `deny` |
| `POST /v1/app-instances/:id/executions/:executionId/cancel` | Cancel an active interactive run |
| `DELETE /v1/app-instances/:id` | Cancel work and release the instance |

The instance mutation response contains `status` (`idle`, `running`,
`completed`, or `superseded`), the complete state snapshot, and optional
`operation`, `reason`, and structured Skill result fields. Interactive
completion is recorded under `instance.execution.result`; a successful text
result also updates the declared output state. This JSON is the middle layer
shared by Web, SwiftUI, and other future renderers. Instances expire after 30
minutes without access. The Web renderer keeps browser-session instance IDs so
inputs, outputs, and terminal results survive App navigation, while expired or
missing instances safely reopen from their declared initial state.
The Web workspace gives the active App a bookmarkable clean path such as
`/apps/painers-room`; selecting another App updates browser history and
Back/Forward restores the selection. Switching from Apps to Agent keeps the App
renderer mounted so live polling, questions, approvals, attachments, and local
form state continue; switching back restores the previous App route rather than
opening the first catalog item.
