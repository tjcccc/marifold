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

## Later

- Main `marifold` TUI as the primary entrypoint.
- Schema-defined SkillApp runtime.
- Alias profiles for Codex, Claude Code, and other external agents.
- Workflow composition across native profiles, skill apps, models, and external-agent aliases.
