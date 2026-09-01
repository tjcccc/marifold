# Roadmap

Direction and milestone ladder. History lives in `DEVLOG.md` (newest-first); this file stays
short: what shipped (one line each), what's next, and what's deliberately deferred.

## Shipped

- **v0.8–v0.13 — pre-TUI foundation**: CLI/profile management polish; structured JSONL memory
  system; `@marifold/service` + TaskStore; approval-aware agent loop on `@priest-ai/core` 2.4
  (native tool calling + control-block fallback); selective chat parity (search/read/image,
  OAuth refresh); the earlier declarative app prototype; cron scheduling
  hosted in the service with unattended approval policy.
- **v0.14–v0.25 — the TUI era**: bare `marifold` launches the Ink/React terminal app (agent-first,
  `/chat` mode, approval modal, `/btw` steering, session resume, profile picker); skills run as
  agentic tools reading their own bundled files; interactive onboarding; lean skill runs;
  adaptive planning + `/steps`.
- **v0.26–v0.28 — context management**: conversation compaction (priest 2.5.0) + `/context-window`,
  `/compact`, footer gauge; bounded cross-objective agent memory; per-profile
  `session_context_turns` hard turn window (priest 2.6.0).
- **v0.29–v0.30 — control polish**: session-DB doctor, `/retry`, per-profile `think`; per-profile
  permissions + trusted folders.
- **v0.31–v0.34 — channels & providers**: Telegram bridge (live, in-service; approvals, file
  inbox/outbox); ChatGPT subscription provider (Codex backend) + proxy plumbing.
- **v0.35–v0.36 — the Web UI era begins**: agent-run service routes (`/v1/runs`, SSE + approvals),
  bearer auth + CORS/origin policy, RunRegistry; `apps/web` — the browser client built to the
  committed Claude Design concept (Agent screen with run cards/approvals/steering/catch-up,
  read-only Config, static hosting from the service).
- **v0.37 — Config editing**: service write routes (`PATCH /v1/profiles/:name`, instruction-file
  `PUT`, trusted folders, memory forget/delete, generic `PATCH /v1/config`), editable
  ProfileSettingsPage, CLI `config get`, auth-scope path-normalization hardening.
- **v0.38–v0.39 — Web UI review round**: marigold logo, inline run meta (no card for trivial
  runs), white content pane, collapsible sidebars + session previews, attachments
  (picker/drag-drop/paste, images on `POST /v1/runs`); profile avatars + creation, 3-column
  Config redesign, provider status / live model listing / model management routes, markdown
  blockquotes + horizontal rules.
- **v0.40–v0.41 — xAI + proxy**: `xai` provider (SuperGrok subscription OAuth, PKCE, paste-code
  fallback, `api.x.ai/v1`); uniform per-provider `proxy` key threaded through chat and token
  refresh (priest 2.7.0 dispatcher hook), exposed in web Config → Providers.
- **v0.42–v0.44 — Web composer parity**: avatar crop/compress modal + `assets/` storage;
  `$skill` inline highlight + TUI-parity autocomplete; 15-command `/command` palette (+
  memory-add and session-compact routes); two-row ChatGPT-style composer.
- **v0.45–v0.49 — durable Web workspace**: built-in skill-management guidance; shared image
  optimization; clean desktop routes and transcript rendering; durable image replay and
  in-place historical edits; profile search; session rename/pin/archive/delete/search, per-session drafts,
  global agent/web-search/appearance settings, and authenticated lazy transcript images.
- **v0.50 — safe agent files and execution**: local Word/Excel/PowerPoint extraction;
  bounded read-only original-file staging; capability-scoped per-run workspaces; fail-closed
  macOS shell sandboxing; one-time external-path/package approvals; disposable `uv` Python
  environments; and deterministic service shutdown/listen-failure cleanup.
- **v0.51+ — direct Skills and SkillApp foundation**: history-isolated direct
  Skill invocation; global, statically compiled `skillapp.ts` bundles;
  app-local Skills and explicit models; additive profile references with live
  installed Skills, profile docs, read-only bundles, and App-local memory/history
  controls; exact file/folder read capabilities; attachment-state staging;
  renderer-neutral state/layout/result contracts; and bookmarkable App-name
  routes in the persistent Web workspace shell.

## Next

- **App expansion**: conditional visibility, repeaters, typed artifacts,
  richer design/canvas previews, controlled file export, `$app-creator`, and
  approval-aware effectful actions.
- **Web UI backlog**: `/v1/events` push channel to replace 10s run polling and profile
  rename/delete UI.
- **Workflow composition**: chain native profiles, Skills, Apps, models, and
  external-agent aliases into multi-step flows; the living direction and open questions are in
  [`workflow-plan.md`](workflow-plan.md).
- **Apple clients** and alias profiles for Codex/Claude Code and other external agents.

## Provider-hosted web search

The native-search foundation is implemented in priest protocol 2.9:
`provider_tools` is separate from caller-executed function tools, and OpenAI-
style Responses maps `{type: "web_search"}` to its hosted tool. Marifold enables
that path for OpenAI API, ChatGPT subscription, xAI/Grok, and verified
Bailian/Alibaba model families, prefers it over the DuckDuckGo, Firecrawl, or
Ollama Cloud `WebSearchTool` fallback, and retries once through that fallback
when the provider rejects hosted search before producing output. Bailian's
model-aware matrix covers both Responses tools and Chat Completions
`enable_search`; unknown models remain on fallback unless explicitly
overridden. It reports search as unavailable when neither path exists.

Remaining provider work is deliberately incremental: add and verify Anthropic
server search and Gemini grounding only when each endpoint can be tested.
Citation annotations and hosted-search progress events also remain future
renderer-contract work; the current path preserves final grounded answer text
and usage.
