# TODO

## Session-DB resilience backlog (from v0.29.0 doctor work)

- **`busy_timeout` on priest's `SQLiteSessionStore` write connection.** priest's store already sets `journal_mode=WAL` but has no `busy_timeout`, so the *main chat-write path* still errors (`SQLITE_BUSY`) instead of waiting under lock contention — the path most likely behind the 2026-06-28 corruption (concurrent access, since the DB was already WAL). Highest-leverage concurrency hardening, but it's a **priest change** (reopens the publish + local-link/sync dance). marifold-side connections already got `busy_timeout=5000` in v0.29.0.
- **`marifold session repair` — guided, backup-first recovery (Step 2 of the doctor work).** Codify the manual rescue: back up `sessions.db` → `sqlite3 .recover` into a fresh DB → `PRAGMA integrity_check` → swap only if "ok"; refuse to swap on failure. Recovery ladder when `sqlite3` CLI is absent: JS best-effort row-salvage → reset (move aside + recreate empty). Always back up **before** any open (a read-write open of a corrupt DB can trigger mutating recovery). `marifold doctor` already detects corruption and points here.

## Refactor backlog

- **Split `App.tsx` (TUI controller) into hooks — now testable here, no TTY needed for the logic.** Done so far (v0.25.0+): pure helpers moved to `ui/appHelpers.ts`; the `model`/`provider` pickers pulled out of `commands/model.ts` into `input/ModelPicker.ts`; and a **Tier-2 fake-runtime harness** (`tests/AppRuns.test.tsx`, via `ink-testing-library`) now covers the run-binding logic that was previously uncovered — message → chat/agent routing, `/steps` arming, `/stop` aborting the in-flight run. So a hook extraction can be verified by *extending that harness*, not eyeballed in a terminal. Concrete shape:
  - `useRuns(runtime, { dispatch, stateRef, thinkRef, planNextRef, setPlanNext, notify, approvalHandler })` — *owns* `abortRef`, `cancelChatRef`, `steeringRef`, `pendingContextRef`, `pendingImagesRef`, `steeringCount`; returns `runAgent / runChat / startTextRun / stop` + `enqueueContext / enqueueImage`.
  - `useSkills(...)` layered on `useRuns` — *owns* `pendingSkill`; returns `runSkill / fillSkillVariable / startSkillRun`.
  - Before committing the extraction, extend `AppRuns.test.tsx` to also cover: a skill run routes through `startSkillRun`, and an approval prompt resolves (fake runner calls `approvalHandler`, then drive the modal key). Only true terminal fidelity (the `<Static>` repaint of single-line tool rows, resize reflow, live streaming) still needs a human eyeball — that's Tier 3, out of scope for the refactor's correctness.

## fx-inspired reliability backlog (reviewed 2026-08-20)

These items borrow bounded contracts and lifecycle discipline from `fx` without
changing marifold's product direction. marifold remains a local-first personal
AI workspace and coordinator, not a heavyweight coding agent or general agent
SDK.

### Design next

- **Minimal context provenance and omission tracing.** Centralize the duplicated
  chat/agent request assembly and retain a stable source id, target Priest lane,
  lifetime, and omission reason before projecting into today's `context`,
  `memory`, `userContext`, session, image, and `toolExchange` fields. marifold
  owns product source/trust policy; `@priest-ai/core` continues to own provider
  message projection, token budgeting, and any provider cache semantics. Start
  only with tracing and deterministic projection—do not create a competing
  generic prompt/message model.
- **Workflow run and artifact contracts.** Continue the constrained design in
  `docs/workflow-plan.md`: durable node status, typed inputs/outputs, artifacts,
  approvals, cancellation, and rerun. Let the first Workflow implementation
  reveal which runtime ports and checkpoint boundaries are actually reusable.

### Design with the first real consumer

- **External-agent aliases.** Define a capability-negotiated marifold contract
  for session creation/attachment, prompts, semantic events, permission requests,
  cancellation, close, and result/artifact handoff. Use ACP v1 as one adapter
  when the first real external coding agent supports it; do not make ACP the
  internal run model or force external events into `AgentEvent` losslessly.
- **MCP integration.** Add MCP only for a concrete App or Workflow. Keep server
  transport/auth/discovery/lifecycle separate from execution; adapt an explicitly
  selected MCP tool through `ToolRegistry`, enrich effect metadata beyond the
  current `ToolKind`, lazily advertise schemas, and fail closed on unknown effects.

### Research until a product trigger exists

- **Recoverable execution checkpoints.** Keep conversation history, TaskStore
  activity, live RunRegistry state, and execution recovery separate. Introduce a
  versioned, execution-kind-specific checkpoint only when Workflow nodes,
  external-agent reattachment, or measured interrupted native runs require it.
- **Durable process sessions.** Preserve `shell_exec` as bounded foreground
  execution. Design a service-owned process resource only when a Workflow,
  external-agent CLI, or terminal App needs long-lived input/output. Require an
  owning run/node, immutable capability snapshot, quotas, explicit close, cleanup,
  and backend-specific restart guarantees.
- **ACP v2 and remote transports.** Track the draft and HTTP/WebSocket transport
  work, but keep the first adapter on stable local ACP v1 semantics.

### Non-goals

- No Zig rewrite, binary-size program, Unix-shell-centered product, browser-local
  full agent runtime, public embeddable marifold SDK, universal Agent Host callback
  table, full durable subagent manager, or copied `fx` sandbox defaults.

## Current Plan

- v0.10.0: local service API plus task/session foundation. Done.
- v0.11.0: basic CLI agent loop using the task-state model, with narrow approval-aware tools, native tool calling through `@priest-ai/core` 2.4, and a control-block fallback. Done.
- v0.12.0: selective chat parity — web search and file reading as agent tools reused by chat, ChatGPT OAuth token refresh, and image plumbing. Done.
- App MVP. Done: [docs/app.md](docs/app.md) defines `marifold.app.v0`; core discovers global bundles and resolves explicit actor profiles, the service exposes normalized definitions and transcript-free streamed Skill actions, and Web renders the portable layout tree in a dedicated Apps view. Approval-aware effectful actions and richer components remain deferred.
- v0.13.0: scheduled task execution hosted in `marifold service` with an unattended approval policy. Done.
- Spec 2.4.0 synced across all SDKs (2026-06-12): Python `priest` 2.4.0 (reference), `priest-dotnet` 2.4.0, `priest-rs` 2.4.0, `PriestSwift` 2.4.0 — all with caller-executes tool calling, the run-with-tools loop helper, stream-events (native in TS/Python; fallback wrapping in dotnet/rs/swift), and the tool-turn session persistence rule.
- Publish `@priest-ai/core` 2.4.0 to npm, remove the `link:../priest-typescript` pnpm override in the workspace `package.json`, and reinstall. The other SDK packages (PyPI/NuGet/crates.io/SwiftPM tag) publish from their committed 2.4.0 states.
- Then: the main `marifold` TUI (Codex/Claude-like terminal app), followed by Web UI and macOS/iOS clients. The TUI renders the `AgentEvent` stream and chat streaming; its prerequisites are complete.

## Completed in v0.8.0

- `model rm <provider/model>`: remove a saved marifold model option from `[models].options`; do not delete provider-owned model files.
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

## Completed in v0.11.0

- Upgraded `@priest-ai/core` to 2.4.0: native tool calling (caller-executes contract), `runWithTools` loop helper, `streamEvents` structured streaming, AbortSignal cancellation, and ImageInput parity — with spec docs synced to the priest repository (Python implementation sync pending).
- Added `packages/core/src/agent`: AgentRunner (plan → tool loop → verification → summary over TaskStore at release time), renderer-agnostic AgentEvent stream, ToolRegistry, and approval policy. The separate self-grading verification call was removed in v0.24.2; current checks run through ordinary tools.
- Added built-in tools: `read_file`, `write_file` (workspace jail with escalation), `shell_exec`, and `ask_profile` delegation.
- Added control-block tool fallback for models without native tool support, with automatic switching in `auto` mode.
- Added the optional `[agent]` / `[agent.approval]` config section with config round-tripping.
- Added `marifold agent` with interactive approvals, `--yes`, `--tool-mode`, `--max-iterations`, and Ctrl+C cancellation.
- Updated `MarifoldOpenAICompatProvider` for v2.4 adapter options, including Responses API tool mapping for GitHub Copilot models.
- Added `scripts/agent-eval.mjs` provider-backed agent eval (validated live against Ollama qwen3.5:9b in both native and control-block modes).

## Completed in v0.12.0

- Added a pluggable `SearchBackend` with a DuckDuckGo default (`duck-duck-scrape`, no API key) and a `WebSearchTool` for agent runs (`network` approval kind).
- Added chat `/search <query>` (direct backend call, results injected as turn-local context) and model-initiated `web_search`/`read_file` chat tools behind `[web_search].enabled` using a bounded tool loop with memory-payload deferral to the final response.
- Added chat `/read <path>` file attachment with 100k-char truncation.
- Added image plumbing: `MarifoldRunRequest.images` → `PriestRequest.images`, `ask --image <path>` (repeatable), chat `/image <path>` / `/image clear`, and base64/URL images on service `/v1/ask`.
- Added ChatGPT OAuth token refresh in core (`ChatGptTokenRefresh`), generalizing the provider credential refresh dispatch beyond GitHub Copilot, with refresh-token rotation persisted to config.
- Added the optional `[web_search]` config section with round-tripping.

## Completed in v0.13.0

- Added `packages/core/src/schedule`: file-backed `ScheduleStore` (cron via `croner`, validated expressions) and a minute-resolution `Scheduler` for the service process.
- Added `[paths].schedules_dir` (default `~/.marifold/schedules`) across init, config set, and backup-compatible config rendering.
- Added unattended runs: `AgentRunOptions.unattended` applies `[agent.unattended]` approval overrides; `ask` degrades to deny without a handler.
- Added `marifold schedule add|list|show|rm|enable|disable|run` and scheduler hosting in `marifold service` (opt-out via the service factory).
- Added read-only `/v1/schedules` routes, `scheduled` task tags, and the `lastResultSeen` flag for future unread-result surfacing.
- Validated live: a `* * * * *` schedule fired inside `marifold service` against Ollama and completed a tagged task unattended.

## Future Agent-App Core Features

- Local service API expansion: backup/import routes where practical, client contract docs, generated clients, cancellation, reconnect/resume behavior, and service hardening.
- Ephemeral task memory expansion: richer observations, decisions, blockers, explicit check evidence, compaction, and task-to-memory promotion rules for future agent loops.
- Task/session integration: stronger links between chat sessions, service requests, and task state without making task memory durable profile memory by default.
- Agent-loop evidence: retain bounded observations from focused checks without adding a separate model self-grade or replaying raw tool framing into conversation history.
- Memory expansion: workspace/project scopes, used-memory tracing, semantic retrieval, memory edit UI, optional encryption, and richer redaction.
- Web search: future `/search <query>` chat command plus model-requested search hooks.
- Image paste/upload: terminal image attachment workflow and provider request plumbing.
- OAuth refresh: refresh expired ChatGPT credentials before provider requests, matching priests.
- Web UI: browser chat app backed by the service API, initially focused on chat, profiles, sessions, memory, and task-state inspection.
- Apple clients: macOS/iOS apps after the service API and Web UI stabilize.
- App expansion: conditionals, repeaters, typed artifacts, richer previews/canvases, controlled file export, and approval-aware effectful actions for apps such as email, design, and research helpers.
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
- Agent execution controls: pause, resume, cancel, retry, continue, checkpoint restore, task export/import, failure summaries, and explicit evidence/check status.
- Tool-result management: structured observations, large-output summarization, artifact references, sensitive-output filtering, and a retention policy for raw logs.
- External-agent aliases: Codex and Claude Code wrappers, capability metadata, handoff summaries, result import, and write-conflict safeguards.
- Subagent/delegation model: only after the basic agent loop is stable; use summary-only returns, clear ownership boundaries, and conservative write coordination.
- Web UI: chat, sessions, profiles, memory inspection/editing, task-state inspection, streaming, cancellation, and local service connection management.
- Apple clients (agreed architecture): build native SwiftUI renderers over a shared
  `MarifoldClient` package that consumes the service HTTP/SSE contracts with
  `URLSession`. The macOS app connects directly to the loopback service on its
  host; iOS connects to the Mac mini through private Tailscale Serve HTTPS.
  Keep profiles, memory, skills, sessions, tools, approvals, provider credentials,
  and execution authoritative in the TypeScript service. Store remote bearer
  credentials in Keychain, recover interrupted iOS streams by reloading durable
  task/session state, and reserve PriestSwift for a later explicit offline/local
  execution backend rather than running a second engine in ordinary connected
  clients.
- App and workflow expansion: richer declarative components/actions, workflow composition, external-agent routing, and durable App/workflow history.
- Testing and evaluation: service integration tests, cross-client contract tests, streaming smoke tests, adversarial memory tests, task-state regression tests, and broader provider-backed evals.
- Operations and packaging: install/start/restart behavior, local daemon strategy, log rotation, migrations, diagnostics, crash recovery, and user-friendly troubleshooting.

## Deferred: Topics, Teams, Multi-Profile Orchestration & App UX (design notes, not yet scheduled)

Design conclusions from product discussions (2026-06-22 and 2026-08-27). Captured for later; none of the Topic, Team, or group-chat work below is scheduled for implementation.

- Two profile-to-profile patterns, kept distinct:
  - **Consult (delegate-and-return)** — front profile stays the face, calls a specialist once, relays the result. Already exists as the `ask_profile` tool (in-process via `runtime.ask`; do NOT shell out to `marifold --profile … exec`). Best fit for message bots (Telegram/Slack) where there is a single entry point. Multi-turn happens between user and orchestrator; the delegate call is one-shot with assembled context, so depth-1/stateless is usually sufficient.
  - **Transfer (switch active profile, "转人工")** — conversation ownership moves to the specialist with its own session. Needs per-chat current-profile state + a switch-back path. Only needed when the specialist itself must converse with the user directly.
- **Apps (macOS/iOS) = "profiles as contacts."** A Telegram-like client where profiles are listed like contacts and the user picks one per task. The human is the router, so neither Consult nor Transfer is needed for the primary flow. This is a view layer over existing primitives: profile = contact (own model/persona/mode), session = chat thread (reuses `--resume`/transcript replay), recency = sessions by `updatedAt`. Consult demotes to "a capability some contacts (e.g. a concierge profile) have."
- Decisions locked:
  - **Memory stays per-profile** (actor-model isolation): profiles share by talking, never by reading each other's memory files. Possible single exception: a read-only "owner card" (user's name/timezone) every contact may see — opt-in, not a shared-memory backdoor.
  - **New contact = init a new profile.** Offer starter templates (email writer, translator, coder) = preset profiles.
  - **Skills remain global + profile-scoped. Apps are global bundles with explicit actors.** Existing direct conversations remain profile/session based; future multi-party Topic conversations need their own contract. Apps use their own workspace and do not write Agent transcripts.
- **Topics and Teams are separate global concepts.** They are top-level within one marifold service, not owned by a profile; this does not require equally prominent navigation for both on day one.
  - **Profile = who, Topic = what/where, Session = one conversation, Team = who works together and how.** Existing direct profile conversations remain valid without a Topic.
  - A **Topic** is a persistent shared place with its own instructions, managed files/artifacts, invited profiles and Teams, and multiple conversations or work runs. It may have a default Profile or Team, but any invited actor can work in it. Topic files should reuse the lazy, bounded resource boundary instead of entering every prompt; persistent writes remain explicit and approval-aware.
  - A **Team** is a reusable roster of Profiles with an optional lead and coordination instructions. A Team can be invited into many Topics; a Topic can invite Teams and individual Profiles. Team membership never creates shared Profile memory.
  - **Invitation means awareness and eligibility, not an obligation to answer.** An invited Profile keeps its own identity and private memory, gains the Topic's explicit context while participating, and acts only when selected, mentioned, delegated to, or activated by Team policy.
  - Keep ad hoc Topic participants distinct from saved Teams: inviting Profiles individually creates a local group for that Topic, while inviting a Team brings a reusable roster and collaboration policy.
- **Group chat requires a multi-party conversation contract, not parallel completions.** Silence and turn-taking are core behavior, so do not wake every invited Profile and publish every generated answer.
  - Store an authored room transcript with message author, mentions, and optional reply target. Every participant can observe the durable message later, but only selected Profiles are actively invoked for a given event.
  - Use a renderer-neutral floor-selection step to choose zero or usually one likely speaker from explicit mentions, reply targets, public Profile roles, relevance, and recent participation. The floor selector is not a visible Profile and must not author the answer.
  - Give a selected Profile a structured intent such as `silent`, `react`, `reply`, `redirect`, or `defer`. Silence is a successful terminal outcome, not an error or empty assistant message. A Profile may redirect or mention a better-suited Profile.
  - Project the shared transcript separately for each invoked Profile so its own prior messages and messages from the user or other Profiles retain unambiguous authorship. Do not force multi-party history into the current binary user/assistant session representation.
  - Pass Profile-authored messages through the same routing loop, with cooldowns and a strict cap on Profile-to-Profile turns before waiting for fresh user input. This prevents self-sustaining conversations and response pile-ons.
  - Keep **group chat** (attention, silence, reactions, social initiative) distinct from **Team work** (assignment, delegation, typed handoff, review, completion). They may share a Topic and transcript UI without sharing one orchestration engine.
  - A deliberately narrow first experiment would route direct mentions, otherwise select at most one candidate or nobody, let that Profile reply/silence/redirect, and bound follow-on Profile turns. Richer reactions and spontaneous social behavior can wait.
- **Pipelines / work chains before group chat.** A directed A→B handoff (e.g. Agent A collects stock news → JSON → Agent B writes investment advice). Build this first; group chat (shared room, all-to-all) is deferred and harder to make useful.
  - Keep the pipeline *structure* deterministic (fixed config run by code); the model powers only each *stage*. Do not let a model decide flow for recurring scheduled jobs.
  - The central artifact is the **typed handoff schema** between stages (priest `OutputSpec` enables this) — the schema is the API between agents; free-form string passing is fragile.
  - Reuses existing pieces: profiles as stages, structured output for handoffs, the existing `Scheduler` (service-mode cron) for triggering. A pipeline result can be delivered into a contact thread, bridging autonomous/batch and conversational surfaces.
  - Start with **linear chains** (A→B→C), manual + scheduled triggers, per-stage schema validation + retry, and per-stage output observability. Resist a general DAG engine until a real job needs branching.
  - Architectural hedge for the future: do not hard-assume a session belongs to exactly one profile, so group chat stays possible.

## Product Outlook

- marifold should be a lightweight local-first personal AI workspace, not a direct competitor to heavyweight all-round agents.
- Heavy coding and complex autonomous work can be delegated to external-agent aliases when tools such as Codex or Claude Code are a better fit.
- The core user value is profile-based continuity, memory, focused skill apps, and choosing the right model or agent for each task.
- See [docs/vision.md](docs/vision.md) for the fuller product direction.

## Notes

- v0.10.x includes the TypeScript CLI foundation, upgraded structured profile memory, thinking-mode, model-validation commands, OAuth provider setup, Copilot Responses API routing, config backup/import, saved-model removal, profile rename/delete, bulk session clearing, loopback-only service API, task-state primitives, and command/memory/service test coverage.
- Build the service API before UI/client work, but do not turn it into a large platform before the stable chat, memory, session, and task-state surfaces are proven.
- Build the basic CLI agent before investing in full UI polish, so agent behavior can shape task state and permission boundaries.
- Defer `/search`, image, Web UI, Apple clients, provider-owned model deletion, and broad agentic tool loops until the service/task foundation is predictable.
- marifold can remove saved model references from its config, but should not delete actual local provider model files such as Ollama blobs.
