# Architecture

Marifold v0.13.0 completes the pre-TUI foundation: the basic agent loop (v0.11.0), chat parity (v0.12.0), the SkillApp schema spec, and scheduled task execution (v0.13.0) on top of the v0.10.0 service and task-state foundation. It provides a TypeScript CLI for priests-style profile chat, one-shot requests, an approval-aware agent loop, workspace initialization, chat resume behavior, saved model options, model validation, structured profile memory, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API routing, config backup/import, local management commands, a loopback-only Fastify service API, and an ephemeral task-state subsystem.

## Current Scope

The dependency direction is:

```text
packages/cli -> packages/core -> @priest-ai/core -> provider
packages/cli -> packages/service -> packages/core
```

`packages/cli` owns command parsing, terminal input/output, and the interactive chat loop.

`packages/service` owns HTTP transport only. It starts a Fastify server, parses JSON requests, returns sanitized responses, streams chat chunks through SSE, and delegates behavior to `packages/core`.

`packages/core` owns Marifold runtime abstractions, workspace paths, TOML config loading, profile resolution, profile memory storage/selection/control-block application, the agent subsystem (`src/agent`), task-state persistence, session resolution, provider adapter creation, and the bridge to `@priest-ai/core`.

`@priest-ai/core` remains Marifold-agnostic. Marifold depends on it; it does not know about Marifold. Since 2.4 it carries the model-side agent primitives — native tool-call transport, the `runWithTools` loop helper, structured stream events, cancellation, and image input — while Marifold owns concrete tools, approval policy, and task state. Priest owns talking to models; Marifold owns acting on the world.

## Current Boundaries

The runtime layer is thin. `MarifoldRuntime` resolves config/profile/session settings, selects profile memory with the current prompt and thinking mode, and delegates ask/stream execution to `PriestEngine`. `MarifoldRuntime.createAgentRunner()` wires the agent subsystem over the same engine factory, TaskStore, and config policy.

The agent subsystem lives in `packages/core/src/agent`:

- `AgentRunner` orchestrates plan → tool loop → verification → summary, emitting a renderer-agnostic `AgentEvent` AsyncGenerator. This event union is the contract every client renders — the CLI today, the TUI/Web UI/Apple clients later — so it stays free of terminal formatting.
- `ToolRegistry` holds `AgentTool` implementations: `read_file`, `write_file`, `shell_exec`, and `ask_profile` (depth-1 profile delegation). Tools may flag risky calls (`assessRisk`), which forces interactive approval — `write_file` escalates writes outside the run's working directory.
- `ApprovalPolicy` maps tool kinds (`read`, `write`, `shell`, `network`, `delegate`) to `allow`/`ask`/`deny` from the optional `[agent]` config section. `ask` requires the caller-supplied `ApprovalHandler`; unattended runs degrade `ask` to deny.
- Tool calling is native-first through `@priest-ai/core` 2.4. In `auto` mode, a provider that rejects tools switches the run to control-block mode: prompt-embedded `<tool_call>` blocks parsed with the same pattern as the memory control blocks, so the loop works on small local models too.
- Agent runs bypass the chat memory pipeline. Hidden `<memory_save>`/`<memory_forget>` blocks are stripped from agent output and their payloads discarded; task state is never promoted into profile memory.

Chat reuses the same tool layer selectively: `/search` calls the pluggable `SearchBackend` directly, and `[web_search].enabled` exposes `web_search`/`read_file` as model-initiated chat tools through a bounded tool loop. Intermediate tool turns are turn-local — sessions store only the prompt and final answer, and memory payloads apply only from the final response.

Scheduling lives in `packages/core/src/schedule`: a file-backed `ScheduleStore` (cron via `croner`) and a minute-resolution `Scheduler` hosted inside the `marifold service` process. Scheduled firings are unattended agent runs (`AgentRunOptions.unattended`): `[agent.unattended]` approval overrides apply, and `ask` degrades to deny. Schedule results link to TaskStore tasks tagged `scheduled`.

The SkillApp subsystem (`packages/core/src/skillapp`) is spec-only: `docs/skillapp.md` defines `marifold.skillapp.v0` and the validator enforces it. No runtime or rendering exists until a client UI does.

Config, profile, model, provider, and session commands are local management surfaces. Config export/import copies local config, profile files, memories, and optional sessions; it does not introduce cloud sync. These commands do not introduce agent tools or web/app runtimes.

The service API is local-first and loopback-only in v0.10.0. It exposes health/status, sanitized config/provider/model data, profiles, memories, sessions, ask/chat, SSE streaming chat, and task-state CRUD/event routes. It does not provide remote auth, browser UI, WebSocket sync, multi-user access, or long-running agent execution yet.

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

SQLite session continuity is reused from `@priest-ai/core`.

Task state is stored as JSON files under `paths.tasks_dir`, defaulting to `~/.marifold/tasks`. Task state is generated working context: objective, status, plan, events, summary, next action, profile, and session references. It is separate from durable profile memory and is not promoted into profile memory by default.

## Future Areas

These are planned areas, but they are not implemented in v0.10.0:

```text
apps/web
  Future React Web UI for chat, profiles, and SkillApp panels.

apps/apple
  Future SwiftUI macOS and iOS clients.

SkillApp runtime
  Future system for turning reusable skills into schema-defined GUI mini apps.

Workflow runtime
  Future system for composing native profiles, skills, models, and external agents into multi-step runs.

External-agent aliases
  Future alias profiles that launch, wrap, delegate to, or compose with Codex, Claude Code, and similar tools.

Agent-run service routes
  Future bidirectional channel (SSE plus approval POSTs or WebSocket) so
  app clients can drive agent runs remotely. Read-only /v1/tasks routes
  already expose agent progress.
```

Do not create empty future app directories until implementation begins.

For the product direction behind these future areas, see [vision.md](vision.md).
