# Marifold TUI

The TUI is Marifold's primary interactive surface (v0.14.0). It is a renderer of
two streams the core already produces — `MarifoldRuntime.stream` (chat) and
`AgentRunner.run` → `AgentEvent` (agent) — plus an input grammar and command/skill
registries. It lives in `packages/tui` (Ink + React), an ESM-only package the
CommonJS CLI loads through a dynamic `import()`.

## Launch

```bash
marifold                 # launch the TUI on the default profile (agent mode)
marifold --profile work  # launch on a named profile
```

Bare `marifold` (no subcommand) launches the TUI. All existing subcommands
(`marifold agent`, `marifold chat`, `marifold service`, …) are unchanged and
remain the scriptable surface. When stdout is not a TTY (piped/non-interactive),
the TUI prints a hint and exits instead of starting Ink.

The launch directory is the working directory: `cd ~/notes && marifold` treats
`~/notes` as the workspace. `~/.marifold` stays the config/state home. Profiles
are identities (model + rules + memory + skills), not workspaces.

When no profile resolves a provider/model (e.g. before configuring a default),
the bare launch shows a profile picker; otherwise it goes straight to the
prompt.

## Input grammar

- **plain text** → talk to the agent (or the model in `/chat` mode).
- **`/command [args]`** → an app-executed action. Most commands are local;
  `/retry` and `/attach-original <prompt>` start a model turn intentionally.
- **`$skill [args]`** → run a model-backed skill. `$<name>` *is* the run.

## Input editing

- **History**: Up/Down recall previous inputs.
- **Multi-line**: end a line with `\` to continue onto the next line; Enter on a
  line that does not end with `\` submits.
- **Cursor & readline keys**: Left/Right move; Ctrl+A/Ctrl+E jump to start/end;
  Ctrl+U deletes to start; Ctrl+W deletes the previous word; Backspace removes
  the character before the cursor (including the macOS DEL byte), while Del
  removes the character under the cursor.
- **Tab completion** completes `/command` and `$skill` names.
- **Cancel/exit**: Esc or Ctrl+C cancels a running task; when idle, press Ctrl+C
  twice to exit.

## Commands

`/help` `/exit` (`/quit`) `/new` `/agent` `/chat` `/model` `/profile` `/resume`
`/think on|off` `/clear` `/stop` `/btw <text>` `/permissions` `/skills`
`/install-skill [--global] <path|url>` `/doctor`, plus chat carry-overs `/read`
`/image` `/attach-original <prompt>` `/remember` `/forget` `/delete-memory`.

- `/btw <text>` steers a **running** task without cancelling it: the text is
  queued and handed to the model on its next turn. With no run active, it is sent
  as a normal message.
- `/stop` (or Esc / Ctrl+C while running) cancels the current run.
- `/think on|off` maps to Priest's provider-neutral reasoning configuration on
  Ollama, Anthropic, ChatGPT, and Responses-only GitHub Copilot models (with
  legacy provider options retained for Bailian-compatible endpoints). Safe
  provider summaries appear as muted `Reasoning:` rows before the answer;
  opaque continuation data is never rendered.
- `/attach-original <prompt>` sends every image attached to that message with
  its original encoded bytes, then returns to default optimization for the next
  message. Validation, the four-image count limit, and the 16 MiB aggregate
  source limit still apply. Normal sends resize large images and choose a
  smaller high-fidelity encoding while preserving transparency and animation.
- `/resume` opens a recent-session picker for the current profile; choose with
  Up/Down and Enter. It is ordered strictly by conversation recency; Web UI
  session pins do not influence this TUI workflow. `/session` remains as a
  compatibility alias. Ordinary agent prompts remain in the session after a
  failed or cancelled run, paired with a short terminal outcome so the next
  resume does not silently lose the request. A failed historical regeneration
  leaves the prior successful exchange unchanged.
- `/skills` opens an arrow-key list: Enter runs the selected skill, Del removes it.
- `/agent` / `/chat` switch the **current session's** mode. `/agent default` /
  `/chat default` additionally persist it as the active profile's default mode
  (written to that profile's `profile.toml` as `mode = "agent" | "chat"`), so it
  also applies to future launches. A profile with no `mode` set launches in
  `agent` (the global default); switching profiles adopts the target profile's
  default mode.

## Skills

A skill is a `marifold.skill.v0` markdown file — a YAML frontmatter block with
the metadata, then a prompt body with declared `{{variables}}`. `mode` is
optional (`agent` or `chat`, default `chat`). Skills live in
`[paths].skills_dir` (default `~/.marifold/skills`) and in each profile's
`skills/` directory (profile skills shadow global ones).

Skills are stored as `<name>/SKILL.md` folders (the Claude Code layout).
`/install-skill` accepts either a single `.md` file (saved as `<name>/SKILL.md`)
or a skill **folder** containing a `SKILL.md` (e.g. `/install-skill ./translate`),
which is copied whole. marifold currently only reads `SKILL.md`; bundled files
travel with the skill for future use.

```markdown
---
name: translate
description: Translate text into a target language.
mode: chat
variables:
  - name: language
    default: English
  - name: text
    required: true
---

Translate into {{language}}:

{{text}}
```

Run it with `$translate ja こんにちは` — positional args fill the declared
variables in order, and the final variable absorbs trailing words. Missing
required variables are prompted inline. `/install-skill <path>` adds to the
current profile; `--global` adds for all profiles. Install the bundled examples
with:

```text
/install-skill examples/skills/translate          # a SKILL.md skill folder
/install-skill --global examples/skills/summarize-file.md
```

Installing the same skill name again updates its `SKILL.md`; installing from a
folder replaces that skill's whole folder. `/install-skill` does not uninstall:
use `/skills` (or `/skills --global`) and press Del to remove the selected skill
from that scope.

For ordinary agent prompts that mention skills, Marifold lazily attaches its
built-in `$skill-manager` guide. The guide supplies the active profile and
configured global skill paths so the agent manages Marifold skills instead of
creating another tool's skill directory in the working folder.

There is intentionally no `$new`/`$run`/`$remove` verb. Creating or editing a
skill is either a direct file edit or done by asking the agent in normal input
("make a skill that translates to Japanese") — that is model work, not a command.

A Skill is the shared primitive a graphical **App** renders as a form before
running the selected actor profile's Skill. Apps are not rendered in the TUI.

## Clarification questions

In agent mode, the model may call `ask_user` when essential information is
missing and a reasonable assumption could materially change the result. It is
not a required phase: ordinary tasks continue without a prompt. One checkpoint
may contain up to three questions with two to four suggested choices each,
plus a free-text “Something else” answer supplied by the client.

The TUI shows every question in one keyboard modal. Use Up/Down to choose,
Left/Right to move between questions, Enter to select or edit the custom answer,
then press `s` once every question is complete. Esc cancels the run. This is
separate from tool approval: answering a question never grants filesystem,
shell, network, or delegation permission.

## Permissions

The TUI reuses the core approval engine unchanged (see
[architecture.md](architecture.md)): per tool-kind (`read`/`write`/`shell`/
`network`/`delegate`) × mode (`allow`/`ask`/`deny`). Defaults ship safe and quiet:
`read`+`delegate` allow, `write`+`shell`+`network` ask.

When a tool needs approval, the modal previews the tool's arguments (the file
content being written, the shell command, …) so you approve with sight of *what*
is happening, then offers:

- **allow once** — approve this single call.
- **session `<kind>`** — approve this kind for the rest of the session (in-memory).
- **persist `<kind>`** — write `allow` for this kind to `[agent.approval]` in config.
- **deny**.

Escalated calls (e.g. a write outside the working directory) always prompt,
regardless of any grant. `/permissions` shows current modes and active session
grants. Requests involving external/sensitive filesystem paths and package
installation cannot be persisted, so their modal offers only **allow once** and
**deny**.

Every agent run has a private workspace under `~/.marifold/runs/<run-id>/`.
User-facing `~` and `$HOME` paths continue to resolve to the real account home;
the private run home is internal runtime state only.
On macOS, shell commands run through the system sandbox with network disabled and
writes limited to that run, the selected working folder, and configured in-home
trusted folders. Python uses the run's `.venv`; network package installation is a
separate one-time-approved `uv` tool. Approval never disables these hard limits,
and shell execution fails closed when no supported sandbox backend is available.

## Architecture

Logic lives in pure, unit-tested modules under `packages/tui/src/core/`
(`inputGrammar`, `eventView`, `appState` reducer, `commands`, `skills`); the Ink
components under `packages/tui/src/ui/` stay thin. The agent run wires a TUI
`ApprovalHandler` whose Promise the approval modal resolves, a `UserInputHandler`
whose Promise the question modal resolves, an `AbortController` for cancellation,
and a steering drain closure for `/btw`.
