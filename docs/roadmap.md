# Roadmap

This roadmap captures the current product direction after the v0.7.0 priests migration work.

## v0.8.0 - CLI and Profile Management Polish

Goal: make Marifold feel complete as a local management CLI before adding larger agent surfaces.

Planned scope:

- Remove saved model options without deleting provider-owned model files.
- Validate all saved/default/profile models.
- Rename and delete local profiles with safe confirmations.
- Export and import local config, profiles, memories, and optional sessions.
- Clear sessions in bulk with profile/date/keep-last filters.
- Expand repeatable non-network command smoke coverage.

## v0.9.0 - Memory System Upgrade

Goal: make memory more trustworthy, inspectable, and ready for future agent/task state without implementing the agent loop yet.

Implemented scope:

- Structured profile memory with rich JSONL metadata.
- Priority/relevance recall, simple-prompt gating, thinking-mode priority expansion, and context budgeting.
- Model-driven hidden memory saves/forgets plus conservative prompt fallback extraction.
- Conflict-key canonicalization, deduplication, supersession, prompt-driven forget, and permanent delete.
- Short-term memory trimming through `[memory].size_limit`.
- CLI memory inspection through `profile memory`.
- Deterministic tests and provider-backed `scripts/memory-eval.mjs`.

Deferred discussion:

- Dedicated ephemeral task memory for future agent loops.
- Workspace/project memory scopes beyond profile memory.
- Memory edit UI, semantic retrieval, encryption, and used-memory tracing.

## v0.10.0 - Service and Task-State Foundation

Goal: create a small local API surface for future Web UI, Apple clients, and agent loops without implementing a full agent yet.

Implemented scope:

- New `@marifold/service` package using Fastify.
- Loopback-only `marifold service` command.
- Health/status, sanitized config, provider, model, profile, memory, session, ask, and streaming chat endpoints.
- Server-sent event streaming for chat chunks.
- `paths.tasks_dir` config path, defaulting to `~/.marifold/tasks`.
- Core `TaskStore` with task objective, status, plan, events, summary, next action, profile/session references, and JSON-file persistence.
- Task CRUD and task-event API routes for future agent loops and app clients.

Deferred discussion:

- Auth, CORS/origin policy, remote binding, API versioning docs, generated clients, reconnect/resume behavior, and service daemon packaging.
- Approval-aware agent loop and tool execution.
- Promotion from ephemeral task state into durable profile/workspace memory.

## v0.11.0 - Basic Agent Loop

Goal: a narrow, approval-aware agent loop that shapes the task-state and event model before any client UI is built.

Implemented scope:

- `@priest-ai/core` 2.4: native tool calling, `runWithTools` loop helper, `streamEvents`, cancellation, and image input — spec synced to the priest repository.
- `packages/core/src/agent`: AgentRunner (plan, tool loop, verification, summary), renderer-agnostic AgentEvent stream, ToolRegistry, approval policy.
- Built-in tools: file read/write (workspace jail), shell exec, and `ask_profile` profile delegation (minimal multi-model orchestration).
- Control-block tool fallback for models without native tool support.
- `[agent]` config section, `marifold agent` command, and `scripts/agent-eval.mjs`.

Deferred discussion:

- Agent-run service routes (need a bidirectional approval channel).
- Live streaming deltas inside agent runs (event model already supports it).
- Subagent/delegation beyond depth-1 `ask_profile`.

## v0.12.0 - Selective Chat Parity

Implemented scope:

- Pluggable `SearchBackend` (DuckDuckGo default) reused by the agent `web_search` tool, chat `/search`, and model-initiated chat tools behind `[web_search].enabled`.
- Chat `/read <path>` file attachment; bounded chat tool loop with memory-payload deferral to the final response.
- ChatGPT OAuth token refresh in core with refresh-token rotation, generalizing the Copilot refresh dispatch.
- Image plumbing: `ask --image`, chat `/image <path>` / `/image clear`, service base64/URL images. Terminal image paste stays deferred to the TUI.

## SkillApp Spec

- `docs/skillapp.md` defines `marifold.skillapp.v0` (layout/variables/actions/permissions, aligned with the agent approval vocabulary) with a core TOML parser/validator. No runtime or rendering until a client UI exists.

## v0.13.0 - Scheduled Task Execution

Implemented scope:

- File-backed `ScheduleStore` with validated cron expressions and a minute-resolution `Scheduler` hosted inside `marifold service`.
- Unattended approval policy: `ask` degrades to deny; `[agent.unattended]` overrides can pre-approve specific tool kinds.
- `marifold schedule` management commands, read-only `/v1/schedules` routes, `scheduled` task tags, and the `lastResultSeen` unread flag.
- Schedules fire only while the service runs; daemon packaging stays deferred.

## Later

- Main `marifold` TUI as the primary entrypoint (Codex/Claude-like terminal app), then Web UI, then Apple clients.
- Schema-defined SkillApp runtime.
- Alias profiles for Codex, Claude Code, and other external agents.
- Workflow composition across native profiles, skill apps, models, and external-agent aliases.
