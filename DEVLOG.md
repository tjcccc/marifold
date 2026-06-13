# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-06-13 — tooling — adopt projnavi navigation layer

- Added a `.projnavi/` navigation layer (project/module/flow notes, glossary, 14 evidence-backed claims) and the Claude Code skill at `.claude/skills/projnavi/SKILL.md`. Notes are pointer-style — they defer to `docs/architecture.md`/`AGENTS.md` rather than restating them.
- Added a thin repo `CLAUDE.md` (loads every turn): authoritative-doc pointers + a proactive policy to run `projnavi guide "<task>"` before broad work, with a bounded-upkeep rule (refresh `.projnavi` at release boundaries, not continuously).
- Benchmarked a cross-layer task ("add an http_fetch tool + network approval + CLI render"): projnavi = 1 command / ~870 tokens vs cold full-file orientation ~11.8k tokens (~93% less) or careful targeted reads ~3.6k (~75% less), plus a correctness boost (the flow note enumerates the config-render and test steps a grep pass can miss).
- Also removed a stray `~/tempfiles/greeting.txt` accidentally tracked in v0.13.1.

Open: claim line-ranges drift as files change; `projnavi verify` catches hash drift but re-onboard is manual. Ranking quality depends on claim granularity (keep claims narrow).

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
