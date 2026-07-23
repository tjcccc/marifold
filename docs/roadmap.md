# Roadmap

Direction and milestone ladder. History lives in `DEVLOG.md` (newest-first); this file stays
short: what shipped (one line each), what's next, and what's deliberately deferred.

## Shipped

- **v0.8–v0.13 — pre-TUI foundation**: CLI/profile management polish; structured JSONL memory
  system; `@marifold/service` + TaskStore; approval-aware agent loop on `@priest-ai/core` 2.4
  (native tool calling + control-block fallback); selective chat parity (search/read/image,
  OAuth refresh); `marifold.skillapp.v0` spec (parser/validator, no runtime); cron scheduling
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

## Next

- **SkillApp runtime**: give the Apps tab its runtime — render `marifold.skillapp.v0` layouts,
  wire actions to the agent loop under the existing approval vocabulary. The spec + validator
  (`docs/skillapp.md`, `packages/core/src/skillapp`) have been waiting for this since pre-TUI.
- **Web UI backlog**: `/v1/events` push channel to replace 10s run polling, a deliberate mobile
  navigation design, and profile rename/delete UI.
- **Workflow composition**: chain native profiles, skills, skill apps, models, and
  external-agent aliases into multi-step flows (design doc exists outside the repo).
- **Apple clients** and alias profiles for Codex/Claude Code and other external agents.

## Deferred: native (server-side) web search — a priest milestone, not marifold

Today marifold's `web_search` is a **client-side tool** (`WebSearchTool` → Firecrawl/DuckDuckGo):
marifold runs the search and feeds results back, so it works with **any** tool-calling model,
local or cloud. That covers all current usage and needs no priest change.

"Native" search means the **model's hosting endpoint searches server-side** (you set a request
flag; their servers search and return grounded/cited results). That request body is built only
inside priest's provider adapters, so it can only live in **priest** — "talking to the model" is
priest's domain.

**The trigger to build it** is *not* "a local model with search" — a local model can't search
itself (no internet path), so it always uses the client tool. The real trigger is **adopting a
hosted endpoint that does search server-side and wanting to use it** — e.g. Anthropic's
`web_search` server tool, OpenAI/Gemini grounding, or **Alibaba Cloud Qwen
(`bailian`/`alibaba_cloud`) which exposes a server-side search flag** (the one we could actually
test). Until then, leave priest alone.

**When it's time, scope it tight (don't fan out to all SDKs first):** (1) spec design — how
`PriestRequest` represents a *provider-executed* tool vs a client tool, and how citations come
back via streaming events; (2) implement **one** provider and prove it end-to-end through
marifold's existing `[web_search].provider = "native"` seam; (3) then sync the spec to canonical
Python `priest`, with the Rust/dotnet/Swift ports trailing a milestone.
