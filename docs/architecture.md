# Architecture

Marifold v0.14.0 adds the TUI — an Ink/React terminal app (`packages/tui`) that is the primary interactive surface — on top of the v0.13.0 pre-TUI foundation: the basic agent loop (v0.11.0), chat parity (v0.12.0), the early declarative App spec, and scheduled task execution (v0.13.0). It provides a TypeScript CLI for priests-style profile chat, one-shot requests, an approval-aware agent loop, workspace initialization, chat resume behavior, saved model options, model validation, structured profile memory, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API routing, config backup/import, local management commands, a default-loopback Fastify service API with authenticated opt-in remote binding, an ephemeral task-state subsystem, and the `marifold.skill.v0` skill primitive.

## Current Scope

The dependency direction is:

```text
packages/cli -> packages/core -> @priest-ai/core -> provider
packages/cli -> packages/service -> packages/core
packages/cli -> packages/tui -> packages/core   (dynamic import; ESM)
apps/web -> packages/service (HTTP only; types type-only from packages/core)
```

`packages/cli` owns command parsing, terminal input/output, and the interactive chat loop.

`packages/service` owns HTTP transport only. It starts a Fastify server, parses JSON requests, returns sanitized responses, streams chat chunks through SSE, and delegates behavior to `packages/core`.

`packages/core` owns Marifold runtime abstractions, workspace paths, TOML config loading, profile resolution, profile memory storage/selection/control-block application, the agent subsystem (`src/agent`), task-state persistence, session resolution, provider adapter creation, and the bridge to `@priest-ai/core`.

`@priest-ai/core` remains Marifold-agnostic. Marifold depends on it; it does not know about Marifold. Since 2.4 it carries the model-side agent primitives — native tool-call transport, the `runWithTools` loop helper, structured stream events, cancellation, and image input. In 2.8 it also owns the OpenAI Responses transport, provider-neutral reasoning configuration, safe reasoning summaries, opaque continuation, and cached/reasoning token accounting. Marifold owns concrete tools, approval policy, task state, and rendering. Priest owns talking to models; Marifold owns acting on the world.

## Current Boundaries

The runtime layer is thin. `MarifoldRuntime` resolves config/profile/session settings, selects profile memory with the current prompt and thinking mode, and delegates ask/stream execution to `PriestEngine`. `MarifoldRuntime.createAgentRunner()` wires the agent subsystem over the same engine factory, TaskStore, and config policy.

The agent subsystem lives in `packages/core/src/agent`:

- `AgentRunner` orchestrates plan → tool loop → verification → summary, emitting a renderer-agnostic `AgentEvent` AsyncGenerator. This event union is the contract every client renders — the CLI today, the TUI/Web UI/Apple clients later — so it stays free of terminal formatting.
- `ToolRegistry` holds effectful `AgentTool` implementations (`read_file`, `write_file`, isolated `shell_exec`, per-run `python_package_install`, and depth-1 `ask_profile`) plus the interaction-only `ask_user` tool. Effectful tools may flag risky calls (`assessRisk`), which forces approval; `ask_user` instead emits a bounded, validated question request and waits for one complete submission without entering the permission system.
- `RunWorkspace` creates a private capability set under `~/.marifold/runs/<run-id>/`: internal runtime-home state, staged read-only inputs, work/output/temp/cache, and `.venv`. User-facing `~`/`$HOME` retain normal account-home semantics; the sandbox separately denies broad home access and reopens only explicit capabilities. The active profile and configured global skill directories are added as narrow read-only roots when they resolve inside the user's home; they never become write roots, and external configured paths remain approval-gated. Shell execution goes through `ScopedProcess`; macOS uses Seatbelt and unsupported platforms fail closed instead of falling back to the host. Shell network is denied, filesystem writes are allowlisted, global runtime/package directories stay read-only, and common host-control channels (unrelated signals, Apple Events, clipboard, Launch Services mutation, keychain IPC) are denied.
- `python_package_install` is the only network-enabled process path. It accepts registry requirement names only, invokes `uv` into the per-run `.venv`, always requires one-time approval, and mounts only disposable environment directories so package build hooks cannot read user inputs or a selected repository.
- `ApprovalPolicy` maps tool kinds (`read`, `write`, `shell`, `network`, `delegate`) to `allow`/`ask`/`deny` from the optional `[agent]` config section. `ask` requires the caller-supplied `ApprovalHandler`; unattended runs degrade `ask` to deny.
- Tool calling is native-first through `@priest-ai/core` 3.0. Responses and Anthropic tool loops carry opaque reasoning continuation back to the same provider while exposing only safe summary text to Marifold renderers. In `auto` mode, a provider that rejects tools switches the run to control-block mode: prompt-embedded `<tool_call>` blocks parsed with the same pattern as the memory control blocks, so the loop works on small local models too.
- Agent runs bypass the chat memory pipeline. Hidden `<memory_save>`/`<memory_forget>` blocks are stripped from agent output and their payloads discarded; task state is never promoted into profile memory.
- Interactive agent sessions persist one clean user→assistant pair per append-only run. Successful runs store the final answer; failed or cancelled runs store a concise terminal outcome so submitted prompts survive resume without exposing raw tool-loop framing. Failed historical regenerations do not replace the prior successful exchange.

Chat reuses the same tool layer selectively: `/search` calls the pluggable `SearchBackend` directly, and `[web_search].enabled` exposes `web_search`/`read_file` as model-initiated chat tools through a bounded tool loop. Intermediate tool turns are turn-local — sessions store only the prompt and final answer, and memory payloads apply only from the final response.

Scheduling lives in `packages/core/src/schedule`: a file-backed `ScheduleStore` (cron via `croner`) and a minute-resolution `Scheduler` hosted inside the `marifold service` process. Scheduled firings are unattended agent runs (`AgentRunOptions.unattended`): `[agent.unattended]` approval overrides apply, and `ask` degrades to deny. Schedule results link to TaskStore tasks tagged `scheduled`.

The App subsystem (`packages/core/src/app`) defines and validates
`marifold.app.v0`, discovers global `<apps_dir>/<name>/app.toml` bundles,
validates renderer state, and resolves declarative actor Skill actions. Each
action names an App-local actor whose profile supplies model settings, Skills,
and optional context. The service is authoritative: clients receive normalized
definitions and submit only values, while core owns the actor, Skill, argument
templates, permissions, and execution policy. App actions never use Agent
sessions. The Web UI keeps one persistent workspace shell and replaces only
the sidebar catalog body and right-pane content; the Apps view renders the
portable layout tree without showing Agent profiles, sessions, transcripts, or
the composer. The MVP executes chat-mode Skill actions; approval-aware
effectful actions and richer components remain reserved.

The skill subsystem (`packages/core/src/skill`) defines the `marifold.skill.v0` primitive — a prompt template with declared `{{variables}}` and an optional run mode. `SkillStore` loads skills from `[paths].skills_dir` (default `~/.marifold/skills`) and each profile's `skills/` directory, with profile skills shadowing global ones; `parseSkill`/`renderSkillPrompt` validate and expand them. The TUI invokes an indexed skill directly with core's binding rules; service/Web clients use `resolveSkillInvocation` to do the same over HTTP. Both paths resolve exactly one skill before model execution, inject its expanded body and bundled-file directory, preserve the typed invocation in durable history, and use history-isolated execution so one prompt skill cannot inherit another prompt skill's style. A Skill is also the shared unit a graphical App consumes: the App binds typed UI state to a selected actor profile's Skill. See `docs/tui.md`.

The TUI (`packages/tui`, Ink/React) is the primary interactive surface and a pure renderer of two existing core streams — `MarifoldRuntime.stream` (chat) and `AgentRunner.run`→`AgentEvent` (agent). It adds no model-side logic. It is an ESM-only package the CommonJS CLI loads through a dynamic `import()` (kept a real import via a `new Function` escape hatch so `tsc`'s CommonJS emit does not turn it into a `require()`). Logic lives in pure, unit-tested modules under `src/core/` (input grammar, event→view mapping, an `appState` reducer, command/skill registries); Ink components under `src/ui/` stay thin. The `/btw` steering hook (`AgentRunOptions.steering`) drains queued user guidance between iterations. Approval UX (allow-once / session-grant / persist-to-config / deny) reuses the core `ApprovalPolicy`; non-persistable risks expose only allow-once/deny, while the process sandbox enforces the hard filesystem and network ceiling independently of approval. Optional `ask_user` events open a separate keyboard question modal, batch every answer, and resume through `AgentRunOptions.userInputHandler`.

The Web UI (`apps/web`, Vite + React 19) is the second interactive surface and a pure renderer of the service API — it holds no model-side logic and reaches core only through HTTP (its wire types are `import type`-only re-exports from `@marifold/core`, funneled through one file). It mirrors the TUI's thin-components/fat-testable-core split: `api/` (fetch + SSE + the resumable `followRun` loop), `state/` (a pure `threadReducer` grouping runs into cards — the web analogue of the TUI's `applyAgentEvent` — plus a `RunFollowers` manager), `lib/` (markdown/format/permissions/clean-path routing), with React confined to `components/` and `screens/`. One conversation thread carries both reply kinds: plain chat turns (streamed) and agent runs (live cards with plan, folding tool rows, optional batched question sheets, the separate approval sheet, steering pills, cancel, and catch-up replay after reloads). Send routing follows the profile's resolved mode, the same rule the Telegram bridge applies. The shell keeps named service connections: the built-in same-origin server plus validated remote HTTP(S) roots with independent bearer tokens. Switching servers remounts data-owning screens and namespaces last routes and drafts by connection so stale profiles, sessions, and live requests cannot cross that boundary. In production `marifold service` hosts the built bundle same-origin (`[service].web_dir` / `--web-dir`, hand-rolled static routes with a traversal guard and extensionless SPA fallback for direct clean-path loads); bearer auth is scoped to `/v1/*` so the shell stays reachable, and an Origin equal to the request's allowed Host passes the origin policy. In development the Vite dev server binds to `127.0.0.1` and talks to the service cross-origin via `--cors-origin http://127.0.0.1:5173`.

Config, profile, model, provider, and session commands are local management surfaces. Config export/import copies local config, profile files, memories, and optional sessions; it does not introduce cloud sync. These commands do not introduce agent tools or web/app runtimes.

The service API is local-first and defaults to loopback. It exposes health/status, sanitized config/provider/model data, profiles, memories, sessions, ask/chat, SSE streaming chat, task-state CRUD/event routes, read-only schedules, and — since v0.35.0 — live agent-run routes: `POST /v1/runs` starts a run through core's `RunRegistry` (`packages/core/src/runs`), `GET /v1/runs/:id/events` streams the `AgentEvent` union over resumable SSE (sequence ids, `Last-Event-ID` replay, heartbeats), and clarification/approval/steer/cancel POSTs drive it mid-flight. The registry holds the live layer TaskStore cannot (abort handle, pending clarification/approval resolution, steering queue, event buffer). Clarifications validate all answers against the exact pending request and never grant capabilities; approval semantics (once/always/trust/deny with profile persistence and timeout auto-deny) remain distinct. Security is one `onRequest` hook: an exact-match CORS origin allowlist (`[service].cors_origins`), bind-scope Host validation, and bearer-token auth (`[service].token_env`) that is optional on loopback but mandatory for an explicit non-loopback bind. The service-hosted Web UI is same-origin at either scope. Service lifecycle is bounded: SIGINT/SIGTERM closes Fastify and its runtime owners before explicit process termination, a second signal or five-second timeout forces connection closure, and listen failures run the same ownership cleanup. The wire contract is documented in [service-api.md](service-api.md); the AgentEvent union serialized verbatim is that contract. Still absent: WebSocket sync and multi-user access.

Model validation checks local configuration and provider model-list endpoints where available. It does not delete, pull, or mutate local provider storage.

Profiles are loaded from priests-style directories:

```text
profiles/default/
  PROFILE.md
  RULES.md
  CUSTOM.md
  profile.toml
  memories/
    user.jsonl
    preferences.jsonl
    auto_short.jsonl
```

Marifold owns the profile memory file meaning and passes selected memory to `@priest-ai/core` through `PriestRequest.memory`. The memory path can be disabled per profile through `profile.toml` or per run through `--no-memories`. When enabled, Marifold injects memory policy instructions, strips hidden `<memory_save>` and `<memory_forget>` blocks from visible output and saved session history, applies JSONL mutations after the turn, applies conservative prompt fallback extraction, applies prompt-driven forgets, and trims low-priority short-term memory.

Structured memory is stored in JSONL under profile directories. The current memory subsystem is integrated inside `packages/core/src/memory`, but it is intentionally package-shaped: schema, persistence, selection, prompt/control extraction, and policy remain separated enough to extract into a future `@marifold/memory` package once agent/task memory requirements settle.

Memory is context, not authority. Human-authored profile files and the current user message outrank memory. Normal recall includes priority `0..3`, thinking mode includes priority `0..10`, and simple greetings include only priority `0` memories.

Thinking mode is a provider option selected by Marifold and only forwarded to known compatible providers. It does not change context assembly or introduce agent behavior.

SQLite session continuity is reused from `@priest-ai/core`. Marifold-owned
metadata stays in companion tables in that same database:
`marifold_session_display` holds session title/pin/archive state,
`marifold_profile_display` holds profile pin state,
`marifold_turn_attachments` holds display-only image sources, and
`marifold_response_metrics` holds content-free timing/model/token/cost metadata
for completed chat and agent exchanges. Response metrics use the stable
zero-based user-turn ordinal rather than Priest's rewritten SQLite turn ids;
session rename, edit, truncate, clear, and delete operations maintain the
companion rows. Profile contact previews and activity dates are derived from
the latest durable session/assistant turn rather than copied into profile files
or model context. Removing a stored profile clears its profile-display row but
deliberately retains its session turns and response metrics.

Task state is stored as JSON files under `paths.tasks_dir`, defaulting to `~/.marifold/tasks`. Task state is generated working context: objective, status, plan, events, summary, next action, profile, and session references. It is separate from durable profile memory and is not promoted into profile memory by default.

## Future Areas

These are planned areas, but they are not implemented in v0.10.0:

```text
apps/apple
  Future SwiftUI macOS and iOS clients.

App expansion
  Future richer components, typed artifacts, and approval-aware effectful actions.

Workflow runtime
  Future system for composing native profiles, skills, models, and external agents into multi-step runs.

External-agent aliases
  Future alias profiles that launch, wrap, delegate to, or compose with Codex, Claude Code, and similar tools.
```

Do not create empty future app directories until implementation begins.

For the product direction behind these future areas, see [vision.md](vision.md).
