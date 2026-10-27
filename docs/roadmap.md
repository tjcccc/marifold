# Roadmap

Direction and milestone ladder. History lives in `DEVLOG.md` (newest-first); this file stays short: what shipped (one line each), what's next, and what's deliberately deferred.

## Shipped

- **v0.8–v0.13 — pre-TUI foundation**: CLI/profile management polish; structured JSONL memory system; `@marifold/service` + TaskStore; approval-aware agent loop on `@priest-ai/core` 2.4 (native tool calling + control-block fallback); selective chat parity (search/read/image, OAuth refresh); the earlier declarative app prototype; cron scheduling hosted in the service with unattended approval policy.
- **v0.14–v0.25 — the TUI era**: bare `marifold` launches the Ink/React terminal app (agent-first, `/chat` mode, approval modal, `/btw` steering, session resume, profile picker); skills run as agentic tools reading their own bundled files; interactive onboarding; lean skill runs; adaptive planning + `/steps`.
- **v0.26–v0.28 — context management**: conversation compaction (priest 2.5.0) + `/context-window`, `/compact`, footer gauge; bounded cross-objective agent memory; per-profile `session_context_turns` hard turn window (priest 2.6.0).
- **v0.29–v0.30 — control polish**: session-DB doctor, `/retry`, per-profile `think`; per-profile permissions + trusted folders.
- **v0.31–v0.34 — channels & providers**: Telegram bridge (live, in-service; approvals, file inbox/outbox); ChatGPT subscription provider (Codex backend) + proxy plumbing.
- **v0.35–v0.36 — the Web UI era begins**: agent-run service routes (`/v1/runs`, SSE + approvals), bearer auth + CORS/origin policy, RunRegistry; `apps/web` — the browser client built to the committed Claude Design concept (Agent screen with run cards/approvals/steering/catch-up, read-only Config, static hosting from the service).
- **v0.37 — Config editing**: service write routes (`PATCH /v1/profiles/:name`, instruction-file `PUT`, trusted folders, memory forget/delete, generic `PATCH /v1/config`), editable ProfileSettingsPage, CLI `config get`, auth-scope path-normalization hardening.
- **v0.38–v0.39 — Web UI review round**: marigold logo, inline run meta (no card for trivial runs), white content pane, collapsible sidebars + session previews, attachments (picker/drag-drop/paste, images on `POST /v1/runs`); profile avatars + creation, 3-column Config redesign, provider status / live model listing / model management routes, markdown blockquotes + horizontal rules.
- **v0.40–v0.41 — xAI + proxy**: `xai` provider (SuperGrok subscription OAuth, PKCE, paste-code fallback, `api.x.ai/v1`); uniform per-provider `proxy` key threaded through chat and token refresh (priest 2.7.0 dispatcher hook), exposed in web Config → Providers.
- **v0.42–v0.44 — Web composer parity**: avatar crop/compress modal + `assets/` storage; `$skill` inline highlight + TUI-parity autocomplete; 15-command `/command` palette (+ memory-add and session-compact routes); two-row ChatGPT-style composer.
- **v0.45–v0.49 — durable Web workspace**: built-in skill-management guidance; shared image optimization; clean desktop routes and transcript rendering; durable image replay and in-place historical edits; profile search; session rename/pin/archive/delete/search, per-session drafts, global agent/web-search/appearance settings, and authenticated lazy transcript images.
- **v0.50 — safe agent files and execution**: local Word/Excel/PowerPoint extraction; bounded read-only original-file staging; capability-scoped per-run workspaces; fail-closed macOS shell sandboxing; one-time external-path/package approvals; disposable `uv` Python environments; and deterministic service shutdown/listen-failure cleanup.
- **v0.51–v0.52 — direct Skills and SkillApp foundation**: history-isolated direct Skill invocation; global, statically compiled `skillapp.ts` bundles; app-local Skills and explicit models; additive profile references with live installed Skills, profile docs, read-only bundles, and App-local memory/history controls; exact file/folder read capabilities; attachment-state staging; renderer-neutral state/layout/result contracts; and bookmarkable App-name routes in the persistent Web workspace shell.
- **v0.53–v0.62 — service access and packaging**: authenticated remote service binding and switching, optional agent clarification questions, a managed service daemon, private-network access, live ChatGPT model discovery, profile display names, and the single npm package with self-update.
- **v0.63–v0.69 — documents, Skills, and agent-first**: a local document workspace with generated artifacts, protected skill management, the mobile Web workspace, model-driven and profile-backed SkillApps with an interactive builder, unified profile instructions, and ordinary messages always running as Agent tasks.
- **v0.70–v0.77 — device-hosted workspaces**: a personal bridge relay connecting the owner's devices, cross-device delegation and downloads, built-in web research, image variants, and device-local full execution with requester-side sudo.
- **v0.78–v0.81 — terminal and robustness**: the full-screen TUI, exclusive sessions with takeover between devices, security and workspace hardening, and enforced code standards (lint rules, a publish gate, and module splits).
- **v0.83–v0.102 — the agent computer, permissions, and context**: sessions saved on send and agent memory in runs; the agent computer (a VM with an account per profile) and executor-only devices; global Deep; bridge on Cloudflare with device proxies; one-owner file permissions with Trash-backed writes, home-relative trusted folders, scoped Python and `write_folder` approvals, `/add-dir`; a context budget that follows the model with inline agent compaction; API-contract groundwork.

## Next

The Web UI is the primary client until Projects, Artifacts, SkillApps, and Workflows are complete there, so new product surface is built for one platform at a time. In order:

- **Projects and Assets**: shared places for ongoing work with project instructions, invited profiles addressed by `@` (a Lead answers by default), and stored or device-linked assets that later work builds on; design in [`projects.md`](projects.md). Projects shipped in v0.103.0 and Assets in v0.104.0. They come first because Artifacts, SkillApp results, and Workflow outputs need a home wider than one session.
- **Artifacts**: model-made live pages (HTML or small apps), stored as project assets and rendered in a sandboxed panel beside the conversation, updated in place as new versions by later replies. Its safe rendering surface is shared with SkillApps (design previews, typed results, file export), and an artifact can later become a SkillApp.
- **SkillApp expansion**: conditional visibility, repeaters, typed artifacts, richer design/canvas previews, controlled file export, `$app-creator`, and approval-aware effectful actions.
- **Workflow composition**: chain native profiles, Skills, Apps, models, and external-agent aliases into multi-step flows; the living direction and open questions are in [`workflow-plan.md`](workflow-plan.md).
- **Web UI backlog**: `/v1/events` push channel to replace 10s run polling and profile rename/delete UI.
- **Bridge setup**: simplify installation and configuration, reducing manual steps for bringing a personal bridge online and pairing devices.
- **Stable API contract** (ongoing, alongside the above): additive changes within `v1`, checked-in wire examples, and a reported service version (see Compatibility in [`service-api.md`](service-api.md)), so a later native client does not drift.
- **Alias profiles** for Codex/Claude Code and other external agents.

## Deferred

- **Apple clients (macOS, iOS)**: postponed until the Web UI is complete, to avoid building for two platforms at once. They will be clients of the same service; before they start they need the `/v1/events` push channel, one-step bridge pairing for a phone, and generated Swift models from the API contract.
## Provider-hosted web search

The native-search foundation is implemented in priest protocol 2.9: `provider_tools` is separate from caller-executed function tools, and OpenAI- style Responses maps `{type: "web_search"}` to its hosted tool. Marifold enables that path for OpenAI API, ChatGPT subscription, xAI/Grok, and verified Bailian/Alibaba model families, prefers it over the DuckDuckGo, Firecrawl, or Ollama Cloud `WebSearchTool` fallback, and retries once through that fallback when the provider rejects hosted search before producing output. Bailian's model-aware matrix covers both Responses tools and Chat Completions `enable_search`; unknown models remain on fallback unless explicitly overridden. It reports search as unavailable when neither path exists.

Remaining provider work is deliberately incremental: add and verify Anthropic server search and Gemini grounding only when each endpoint can be tested. Citation annotations and hosted-search progress events also remain future renderer-contract work; the current path preserves final grounded answer text and usage.
