# TODO

## Session-DB resilience backlog (from v0.29.0 doctor work)

- **`busy_timeout` on priest's `SQLiteSessionStore` write connection.** priest's store already sets `journal_mode=WAL` but has no `busy_timeout`, so the *main chat-write path* still errors (`SQLITE_BUSY`) instead of waiting under lock contention — the path most likely behind the 2026-06-28 corruption (concurrent access, since the DB was already WAL). Highest-leverage concurrency hardening, but it's a **priest change** (reopens the publish + local-link/sync dance). marifold-side connections already got `busy_timeout=5000` in v0.29.0.
- **`marifold session repair` — guided, backup-first recovery (Step 2 of the doctor work).** Codify the manual rescue: back up `sessions.db` → `sqlite3 .recover` into a fresh DB → `PRAGMA integrity_check` → swap only if "ok"; refuse to swap on failure. Recovery ladder when `sqlite3` CLI is absent: JS best-effort row-salvage → reset (move aside + recreate empty). Always back up **before** any open (a read-write open of a corrupt DB can trigger mutating recovery). `marifold doctor` already detects corruption and points here.

## fx-inspired reliability backlog (reviewed 2026-08-20)

These items borrow bounded contracts and lifecycle discipline from `fx` without changing marifold's product direction. marifold remains a local-first personal AI workspace and coordinator, not a heavyweight coding agent or general agent SDK.

### Design next

- **Minimal context provenance and omission tracing.** Centralize the duplicated chat/agent request assembly and retain a stable source id, target Priest lane, lifetime, and omission reason before projecting into today's `context`, `memory`, `userContext`, session, image, and `toolExchange` fields. marifold owns product source/trust policy; `@priest-ai/core` continues to own provider message projection, token budgeting, and any provider cache semantics. Start only with tracing and deterministic projection—do not create a competing generic prompt/message model.
- **Workflow run and artifact contracts.** Continue the constrained design in `docs/workflow-plan.md`: durable node status, typed inputs/outputs, artifacts, approvals, cancellation, and rerun. Let the first Workflow implementation reveal which runtime ports and checkpoint boundaries are actually reusable.

### Design with the first real consumer

- **External-agent aliases.** Define a capability-negotiated marifold contract for session creation/attachment, prompts, semantic events, permission requests, cancellation, close, and result/artifact handoff. Use ACP v1 as one adapter when the first real external coding agent supports it; do not make ACP the internal run model or force external events into `AgentEvent` losslessly.
- **MCP integration.** Add MCP only for a concrete App or Workflow. Keep server transport/auth/discovery/lifecycle separate from execution; adapt an explicitly selected MCP tool through `ToolRegistry`, enrich effect metadata beyond the current `ToolKind`, lazily advertise schemas, and fail closed on unknown effects.

### Research until a product trigger exists

- **Recoverable execution checkpoints.** Keep conversation history, TaskStore activity, live RunRegistry state, and execution recovery separate. Introduce a versioned, execution-kind-specific checkpoint only when Workflow nodes, external-agent reattachment, or measured interrupted native runs require it.
- **Durable process sessions.** Preserve `shell_exec` as bounded foreground execution. Design a service-owned process resource only when a Workflow, external-agent CLI, or terminal App needs long-lived input/output. Require an owning run/node, immutable capability snapshot, quotas, explicit close, cleanup, and backend-specific restart guarantees.
- **ACP v2 and remote transports.** Track the draft and HTTP/WebSocket transport work, but keep the first adapter on stable local ACP v1 semantics.

### Non-goals

- No Zig rewrite, binary-size program, Unix-shell-centered product, browser-local full agent runtime, public embeddable marifold SDK, universal Agent Host callback table, full durable subagent manager, or copied `fx` sandbox defaults.

## Open backlog

Shipped history lives in `DEVLOG.md` and the `docs/roadmap.md` ladder; this list keeps only what is not built yet.

### Product

- Apple clients (agreed architecture): build native SwiftUI renderers over a shared `MarifoldClient` package that consumes the service HTTP/SSE contracts with `URLSession`. The macOS app connects directly to the loopback service on its host; iOS connects to the Mac mini through private Tailscale Serve HTTPS. Keep profiles, memory, skills, sessions, tools, approvals, provider credentials, and execution authoritative in the TypeScript service. Store remote bearer credentials in Keychain, recover interrupted iOS streams by reloading durable task/session state, and reserve PriestSwift for a later explicit offline/local execution backend rather than running a second engine in ordinary connected clients.
- External-agent aliases: Codex and Claude Code wrappers, capability metadata, handoff summaries, result import, and write-conflict safeguards.
- App and Workflow expansion: conditionals, repeaters, typed artifacts, richer previews/canvases, controlled file export, approval-aware effectful actions, and workflow composition across profiles, Skills, Apps, models, and external-agent aliases (`docs/workflow-plan.md`).
- Web UI: a `/v1/events` push channel to replace run polling, and profile rename/delete.
- Bridge setup: fewer manual steps to bring a personal bridge online and pair devices.

### Platform

- Service contract: OpenAPI or equivalent contract docs, request IDs, rate limits and backpressure, and audit logging.
- Agent execution controls: pause, resume, checkpoint restore, and task export/import.
- Tool-result management: structured observations, large-output summarization, artifact references, sensitive-output filtering, and a retention policy for raw logs.
- Memory promotion: explicit rules and UI/API controls for promoting stable task discoveries into durable profile or workspace memory, including evidence, confidence, redaction, and user deletion.
- Memory retrieval upgrades: workspace/project scopes, semantic retrieval, used-memory tracing, conflict review, optional encryption.
- Testing and operations: cross-client contract tests, adversarial memory tests, log rotation, migrations, and crash recovery.

### Code health (from the 2026-10-09 health check)

- Files still over 800 lines, held by the ratchet: `AgentRunner.ts` (see below), Web `useAgentController.ts` 1,147 (`sendMessage` is the riskiest Web path; split it only with dedicated tests), `MarifoldRuntime.ts` 1,032 (the store facade plus agent wiring; further moves would only add host interfaces), `SessionResolver.ts` 983 (priest session queries), and TUI `App.tsx` 920.
- The Web e2e fixture (`apps/web/tests/e2e/start-fixture.mjs`) writes an artifact under the real `~/.marifold/runs` through `os.homedir()`; give it a temporary home. Two e2e tests (Connection switching, session image gallery) fail under a temporary `HOME` back to v0.80.0.
- `AgentRunner.ts`: split its 366-line loop together with the context provenance work above.
- `spec/ui.md` open questions that need a design decision: the type scale and radius literals.

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
