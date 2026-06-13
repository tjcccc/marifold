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
- **`/command [args]`** → a deterministic, code-executed command. Commands never
  call the model.
- **`$skill [args]`** → run a model-backed skill. `$<name>` *is* the run.

## Input editing

- **History**: Up/Down recall previous inputs.
- **Multi-line**: end a line with `\` to continue onto the next line; Enter on a
  line that does not end with `\` submits.
- **Cursor & readline keys**: Left/Right move; Ctrl+A/Ctrl+E jump to start/end;
  Ctrl+U deletes to start; Ctrl+W deletes the previous word; Backspace works
  (including the macOS DEL the terminal sends).
- **Tab completion** completes `/command` and `$skill` names.
- **Cancel/exit**: Esc or Ctrl+C cancels a running task; when idle, press Ctrl+C
  twice to exit.

## Commands

`/help` `/exit` (`/quit`) `/new` `/agent` `/chat` `/model` `/profile` `/session`
`/think on|off` `/clear` `/stop` `/btw <text>` `/permissions` `/skills`
`/install-skill <path|url>` `/doctor`, plus chat carry-overs `/search` `/read`
`/image` `/remember` `/forget` `/delete-memory`.

- `/btw <text>` steers a **running** task without cancelling it: the text is
  queued and handed to the model on its next turn. With no run active, it is sent
  as a normal message.
- `/stop` (or Esc / Ctrl+C while running) cancels the current run.
- `/skills` opens an arrow-key list: Enter runs the selected skill, Del removes it.

## Skills

A skill is a `marifold.skill.v0` TOML file — a prompt template with declared
`{{variables}}` and an optional `mode` (`agent` or `chat`). Skills live in
`[paths].skills_dir` (default `~/.marifold/skills`) and in each profile's
`skills/` directory (profile skills shadow global ones).

```toml
schema = "marifold.skill.v0"
name = "translate"
description = "Translate text into a target language."
mode = "chat"
prompt = "Translate into {{language}}:\n\n{{text}}"

[[variables]]
name = "language"
default = "English"

[[variables]]
name = "text"
required = true
```

Run it with `$translate ja こんにちは` — positional args fill the declared
variables in order, and the final variable absorbs trailing words. Missing
required variables are prompted inline. Install the bundled examples with:

```text
/install-skill examples/skills/translate.toml
/install-skill examples/skills/summarize-file.toml
```

There is intentionally no `$new`/`$run`/`$remove` verb. Creating or editing a
skill is either a direct file edit or done by asking the agent in normal input
("make a skill that translates to Japanese") — that is model work, not a command.

A skill is the shared primitive a future graphical **SkillApp** (web/macOS/iOS)
renders as a form before running the same skill. SkillApps are not rendered in
the TUI.

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
grants. This is the simple, kind-level model — per-command/per-path allowlists and
a sandbox are deferred to the future high-stakes-tools milestone.

## Architecture

Logic lives in pure, unit-tested modules under `packages/tui/src/core/`
(`inputGrammar`, `eventView`, `appState` reducer, `commands`, `skills`); the Ink
components under `packages/tui/src/ui/` stay thin. The agent run wires a TUI
`ApprovalHandler` whose Promise the approval modal resolves, an `AbortController`
for cancellation, and a steering drain closure for `/btw`.
