# TODO

## Current Plan

- v0.9.0: structured memory system upgrade. See [docs/roadmap.md](docs/roadmap.md).
- v0.10.0: local service API plus task/session foundation. Implemented a loopback-only Fastify service, stable app-client routes, SSE streaming chat, and task-state primitives.
- v0.11.0: basic CLI agent loop using the task-state model. Keep tools narrow and approval-aware before adding Web UI or Apple clients.
- v0.12.0+: Web UI first, then macOS/iOS clients, backed by the stable local service API.

## Completed in v0.8.0

- `model rm <provider/model>`: remove a saved Marifold model option from `[models].options`; do not delete provider-owned model files.
- `model validate --all`: validate every saved model option plus global/profile defaults.
- `config export <file>` / `config import <file>`: backup and restore local config, profiles, memories, and optional sessions.
- `profile rename <from> <to>` and `profile delete <name>`: local profile management with safe confirmations.
- `session clear`: bulk session cleanup with filters such as `--profile`, `--before`, `--keep-last`, and `--yes`.

## Completed in v0.9.0

- Structured profile memory now stores priority, confidence, stability, source, source type, scope, timestamps, evidence, reason, conflict keys, and supersession status.
- Memory recall now uses priority cutoffs, prompt relevance ranking, simple-prompt gating, thinking-mode expansion, expiry checks, and context budgeting.
- Prompt fallback now captures explicit names, favorite/preferred facts, response-style preferences, meeting times, and prompt-driven forget requests.
- Conflict-key handling now canonicalizes aliases, rejects generic slots, infers common slots, and supersedes older active records.
- `[memory].size_limit` now trims low-priority `auto_short.jsonl` entries.
- `profile memory` lists active or all profile memory records.
- `scripts/memory-eval.mjs` runs provider-backed chat memory checks after `pnpm build`.

## Completed in v0.10.0

- Added `@marifold/service` with a loopback-only Fastify API.
- Added `marifold service` with host/port options and loopback-host enforcement.
- Exposed health/status, sanitized config, providers, models, profiles, profile memory, sessions, ask, streaming chat, and task-state routes.
- Added SSE streaming chat through `/v1/chat/stream`.
- Added `[paths].tasks_dir`, defaulting to `~/.marifold/tasks`.
- Added core task-state storage with objective, status, plan, events, summary, next action, tags, profile/session references, timestamps, and JSON-file persistence.
- Added task-state API routes for create, list, show, update, append event, and delete.
- Added targeted core task-state tests and Fastify inject service tests.

## Future Agent-App Core Features

- Local service API expansion: backup/import routes where practical, client contract docs, generated clients, cancellation, reconnect/resume behavior, and service hardening.
- Ephemeral task memory expansion: richer observations, decisions, blockers, verification, compaction, and task-to-memory promotion rules for future agent loops.
- Task/session integration: stronger links between chat sessions, service requests, and task state without making task memory durable profile memory by default.
- Basic CLI agent loop: narrow file/shell/search capabilities with explicit approval policy, using task state for objective, plan, progress, observations, and verification.
- Memory expansion: workspace/project scopes, used-memory tracing, semantic retrieval, memory edit UI, optional encryption, and richer redaction.
- Web search: future `/search <query>` chat command plus model-requested search hooks.
- Image paste/upload: terminal image attachment workflow and provider request plumbing.
- OAuth refresh: refresh expired ChatGPT credentials before provider requests, matching priests.
- Web UI: browser chat app backed by the service API, initially focused on chat, profiles, sessions, memory, and task-state inspection.
- Apple clients: macOS/iOS apps after the service API and Web UI stabilize.
- SkillApp runtime: schema-defined GUI mini apps for focused skills such as translators, UI design helpers, research helpers, and prompt generators.
- Alias profiles: profile entries that launch, wrap, delegate to, or compose with external agents such as Codex and Claude Code.
- Workflow composition: route subtasks across native profiles, skill apps, models, and external-agent aliases.
- Agent runtime: broader tool-call policy, permission boundaries, and external tool execution after the basic CLI agent loop is stable.

## Deferred Required Work

- Service hardening: API versioning, stable typed client generation, OpenAPI or equivalent contract docs, structured error schema, request IDs, cancellation, timeout policy, service config for host/port/origin/token, and compatibility tests.
- Service security: keep v0.10 loopback-only by default, then add token-based access, CORS/origin policy, remote-bind safeguards, rate limits, backpressure, and audit logging before exposing the service beyond local clients.
- Streaming reliability: reconnect behavior, resume semantics, partial-response persistence, stream cancellation, and client-visible status transitions for chat and future task runs.
- Task-state maturity: compact task summaries, progress checkpoints, objective/plan/decision/blocker fields, raw observation retention policy, task transcript links, and stale-task cleanup.
- Codex-like context hygiene: keep durable instructions in project docs, keep generated memories separate, keep task memory ephemeral by default, summarize agent work instead of replaying logs, and avoid polluting profile memory with short-lived task state.
- Memory promotion: explicit rules and UI/API controls for promoting stable task discoveries into durable profile or workspace memory, including evidence, confidence, redaction, and user deletion.
- Memory retrieval upgrades: workspace/project scopes, semantic retrieval, used-memory tracing, conflict review, background consolidation, external-context gating, secret redaction, optional encryption, and backup/restore compatibility.
- Agent permissions: approval-aware policies for filesystem, shell, network, browser, external agents, and future tool calls, with clear defaults for CLI, Web UI, macOS, and iOS clients.
- Agent execution controls: pause, resume, cancel, retry, continue, checkpoint restore, task export/import, failure summaries, and verification status.
- Tool-result management: structured observations, large-output summarization, artifact references, sensitive-output filtering, and a retention policy for raw logs.
- External-agent aliases: Codex and Claude Code wrappers, capability metadata, handoff summaries, result import, and write-conflict safeguards.
- Subagent/delegation model: only after the basic agent loop is stable; use summary-only returns, clear ownership boundaries, and conservative write coordination.
- Web UI: chat, sessions, profiles, memory inspection/editing, task-state inspection, streaming, cancellation, and local service connection management.
- Apple clients: macOS and iOS clients after the service contract is stable, including local service discovery, auth handoff, background limits, and platform storage rules.
- SkillApp and workflow runtime: schema-defined focused apps, workflow composition, model/profile routing, external-agent routing, and durable workflow history.
- Testing and evaluation: service integration tests, cross-client contract tests, streaming smoke tests, adversarial memory tests, task-state regression tests, and broader provider-backed evals.
- Operations and packaging: install/start/restart behavior, local daemon strategy, log rotation, migrations, diagnostics, crash recovery, and user-friendly troubleshooting.

## Product Outlook

- Marifold should be a lightweight local-first personal AI workspace, not a direct competitor to heavyweight all-round agents.
- Heavy coding and complex autonomous work can be delegated to external-agent aliases when tools such as Codex or Claude Code are a better fit.
- The core user value is profile-based continuity, memory, focused skill apps, and choosing the right model or agent for each task.
- See [docs/vision.md](docs/vision.md) for the fuller product direction.

## Notes

- v0.10.x includes the TypeScript CLI foundation, upgraded structured profile memory, thinking-mode, model-validation commands, OAuth provider setup, Copilot Responses API routing, config backup/import, saved-model removal, profile rename/delete, bulk session clearing, loopback-only service API, task-state primitives, and command/memory/service test coverage.
- Build the service API before UI/client work, but do not turn it into a large platform before the stable chat, memory, session, and task-state surfaces are proven.
- Build the basic CLI agent before investing in full UI polish, so agent behavior can shape task state and permission boundaries.
- Defer `/search`, image, Web UI, Apple clients, provider-owned model deletion, and broad agentic tool loops until the service/task foundation is predictable.
- Marifold can remove saved model references from its config, but should not delete actual local provider model files such as Ollama blobs.
