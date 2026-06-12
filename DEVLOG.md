# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-06-12 — v0.13.1 — pnpm v11 migration and agent path fixes

- Migrated off the removed `pnpm` package.json field (settings live in `pnpm-workspace.yaml` since pnpm v11); dropped the obsolete `@priest-ai/core` override now that 2.4.0 is published, and moved `croner` from the workspace root into `packages/core` where it belongs.
- File tools (`read_file`/`write_file`) and CLI attachments (`/read`, `/image`, `ask --image`) now expand `~` to the home directory; the workspace-jail check assesses the expanded path.
- Agent context now states the working directory and `~` semantics, so models stop guessing locations.
- Verification prompt judges outcome only (not style/approach) — small models like gemma4:e4b no longer mark achieved objectives as `blocked`.
- Verified live: the previously failing "count .md files in ~/dir" objective now completes with correct output; agent-eval passes 3/3 on gemma4:e4b.

Note: when passing objectives on the command line, use single quotes — double quotes let the shell eat backticks via command substitution before marifold ever sees the text.

## 2026-06-12 — v0.13.0 — pre-TUI foundation complete

One combined release spanning three milestones (developed with Claude Code; previously Codex):

- **v0.11.0 agent loop:** `packages/core/src/agent` — AgentRunner (plan → tool loop → verification → summary over TaskStore), renderer-agnostic `AgentEvent` stream (the TUI's future render contract), approval policy (`[agent]`/`[agent.approval]`), tools (`read_file`, `write_file` with workspace jail, `shell_exec`, `ask_profile` delegation), control-block fallback for models without native tools, `marifold agent` command, `scripts/agent-eval.mjs`.
- **v0.12.0 chat parity:** `/search` (pluggable `SearchBackend`, DuckDuckGo default with `[web_search].proxy` support), model-initiated `web_search`/`read_file` chat tools behind `[web_search].enabled`, `/read`, `/image` + `ask --image`, service base64 images, ChatGPT OAuth token refresh with rotation.
- **SkillApp spec:** `docs/skillapp.md` defines `marifold.skillapp.v0`; validator in `packages/core/src/skillapp`. Spec only — no runtime until a client UI exists.
- **v0.13.0 scheduling:** `ScheduleStore` + minute-resolution `Scheduler` hosted in `marifold service`, `marifold schedule` commands, unattended approval (`ask`→deny, `[agent.unattended]` overrides), `/v1/schedules`, `lastResultSeen` flag.
- **SDK:** `@priest-ai/core` 2.4.0 (tool calling, `runWithTools`, `streamEvents`, AbortSignal, images) — spec synced to `priest` and implementations synced to Python/dotnet/rs/Swift SDKs the same day.

Verified: 111 marifold tests, 116 CLI smoke checks, live agent evals against Ollama qwen3.5:9b (native) and gemma4:e4b (auto), live `* * * * *` schedule firing inside `marifold service`.

Open: npm publish of `@priest-ai/core` 2.4.0 + removal of the workspace `link:` override; DuckDuckGo scraping is anomaly-blocked on some networks (proxy config exists; backend is pluggable); terminal image paste and agent-run service routes deferred to the TUI milestone.

Next: the `marifold` TUI (profile-centric home screen rendering the `AgentEvent` stream), then Web UI, then Apple clients.
