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

## v0.37.0 — Config editing (current)

Goal: the Web UI's Config screen becomes a real editor; config writes get a uniform surface.

- Service write routes: `PATCH /v1/profiles/:name` (settings + permission overrides with
  inherit-reset), `PUT /v1/profiles/:name/files/:file` (PROFILE/RULES/CUSTOM), trusted-folder
  add/remove, memory forget/delete, and a generic `PATCH /v1/config { key, value }` with CLI
  parity.
- Core write surface: `ConfigManager` gains `service.*` keys + `getValue`; `ProfileManager`
  gains file editing, trusted-folder removal, approval-override clearing, and
  memories/think/turns setters.
- CLI: net-new `config get <key>`; `config set` covers `[service]` keys.
- Web: editable ProfileSettingsPage (permissions via SegmentedControl with
  inherited-vs-overridden, mode/model/toggles, instruction-file editors, memory Forget/Delete).
- Security: auth-scope gating hardened to normalized pathnames.

## Next

- **v0.38.0 — Web UI SYSTEM screens**: global editing surfaces from the design concept —
  Models & Providers, Default Permissions, Appearance — plus the v0.36 backlog: attachments on
  `POST /v1/runs`, a `/v1/events` push channel to replace run polling, mobile nav polish,
  session title/preview.
- **SkillApp runtime**: give the Apps tab its runtime — render `marifold.skillapp.v0` layouts,
  wire actions to the agent loop under the existing approval vocabulary.
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
