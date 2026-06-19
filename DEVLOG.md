# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-06-19 — v0.15.0 — TUI design polish (inline layout, completion, markdown, usage)

- Visual redesign to the TUIStudio spec: `#EAA221` accent, three-row header banner, `>` prompt, image-drop tokens, and a thinking/run line. New `src/ui/theme.ts`, `Markdown.tsx`, `RunStatus.tsx`, `src/core/displayPaths.ts` (tilde-compress).
- **Inline layout** (Claude-style): banner + transcript render through Ink `<Static>` into native scrollback (persists after exit); run line, input, and status pin below. Submitted input is a turn divider with top/bottom accent rules — plain `>` message, violet `/command`, cyan `$skill` echoes.
- **Input** (`InputBox`): live completion menu for `/commands` and `$skills` (names + descriptions, ↑/↓/Tab/Enter/Esc); image drops → green `[image #n]` tokens (per-message indices) via **bracketed paste** (`ESC[?2004h`) so fragmented/escaped drops coalesce; static block cursor; Ctrl+J / Ctrl-Enter (modifyOtherKeys + CSI-u) / Shift/Alt-Enter newlines; Ctrl+K, Home/End; height bounded to `MAX_INPUT_ROWS` with explicit wrapping (caps the live frame so Ink erases cleanly on delete).
- **Markdown** rendering for assistant output (code fences, headings, lists, inline `code`/**bold**/*italic*).
- **Images in agent mode**: `AgentRunOptions.images` threaded into the first agent turn (priest already supports it); chat path unchanged. Verified end-to-end both modes (test: images on first turn only).
- **Token usage + time**: `runtime.stream` gains a non-breaking `onComplete` callback; `AgentRunner` tallies usage across plan/loop/verify via an engine wrapper into the `done` event's new `AgentUsage`. End-of-run line shows `Task completed. (9.1s, 919 tokens)` — cost only when a provider reports it (local shows tokens). New `UsageInfo`/`AgentUsage` core exports.
- New commands: `/status` (profile, mode, model, thinking, session, turns) and `/copy` (last response's original un-wrapped text via `pbcopy`/`clip`/`xclip`). Overlays recolored to the marifold accent.
- Version 0.14.0 → 0.15.0 across all five packages + CLI `.version`.
- Verified: core 125 tests, TUI 24, all packages `pnpm build`/`typecheck` green; behaviors confirmed via Ink frame dumps.
- **Open**: line-duplication on terminal **resize** persists in inline mode — Ink clears its live region on shrink but can't track the `<Static>` scrollback reflow (header in `<Static>` is unaffected; input rules duplicate). Ink 7 exposes `alternateScreen` (the categorical Codex/vim fix) but it clears on exit. **Plan B next**: keep inline, rework the full-width input border rules (prime reflow suspect) before considering alt-screen. Resize is unverified in the harness (no real TTY).

## 2026-06-13 — v0.14.0 — TUI (the primary interactive entrypoint)

- New `packages/tui` (Ink 7 + React 19), an **ESM-only** package the CommonJS CLI loads via a dynamic `import()` through a `new Function('s','return import(s)')` escape hatch so `tsc` does not downlevel it into a `require()` (which would throw `ERR_REQUIRE_ESM`). Verified the emit contains no `require("@marifold/tui")` and the import resolves at runtime.
- Bare `marifold` (+ root `--profile`) launches the TUI; added `program.enablePositionalOptions()` so the root `--profile` coexists with `model default --profile` (the 116-check command-test passes again). Non-TTY launch prints a hint instead of starting Ink.
- Thin-components / fat-testable-core split: pure `inputGrammar`, `eventView`, `appState` reducer, `commands`, `skills` under `src/core/`; Ink components under `src/ui/` (Header, Transcript, InputBox, ApprovalModal, SelectList, InfoPanel, StatusLine, App).
- Agent-first: renders `AgentRunner.run`→`AgentEvent` and `runtime.stream`; approval modal resolves the TUI `ApprovalHandler` promise with allow-once / session-grant / persist-to-config / deny; escalated calls always prompt; `/permissions` view.
- `/btw` steering: new optional `AgentRunOptions.steering` drain hook in `AgentRunner` surfaces queued guidance to the model via `userContext` between iterations — the one core change, covered by a scripted-engine test; event contract unchanged.
- `marifold.skill.v0` primitive: new `packages/core/src/skill` (schema + validator + templater + store), `[paths].skills_dir` wired through config/init, runtime skill methods, `$name` run path with inline variable prompting, `/skills` manage + `/install-skill`, and two bundled examples in `examples/skills/`.
- Input/layout: `InputBox` does cursor editing (left/right, insert-at-cursor, backspace handling the macOS DEL 0x7f, control-char filtering) inside a rounded border (Claude-Code style); transcript history renders through Ink `<Static>` (native scrollback) so the marifold bar + input + status line stay pinned at the bottom.
- Polish round (post-review): (1) `AgentRunner` plan/loop/verify prompts now steer the model away from gratuitous tool use — conversational objectives answer directly instead of grabbing `write_file` (the "hello → write_file" wart); (2) input history (Up/Down); (3) multi-line input via trailing-`\` continuation; (4) readline keys (Ctrl+A/E/U/W); (5) double-Ctrl+C to exit (single press cancels a run); (6) animated braille thinking spinner (no dep); (7) approval modal previews the tool input (file content / shell command) before you approve; (8) `/session` resume renders past turns; (9) `/install-skill` accepts a URL; (10) Tab completion for `/commands` and `$skills`; (11) launch-time profile picker when no default resolves.
- Tests: core 123 pass (added 14 skill + 1 steering); TUI 23 pass (12 pure-core/component + InputBox history/backspace/multiline/Tab + approval-preview + App mount/mode-switch smoke); service 4 pass; command-test 116 pass. Full `pnpm build`/`typecheck` green across all four packages.
- Open: live token usage not shown (no usage event on the agent stream yet); markdown rendering of replies is deferred pending the UI-design decision; interactive Ollama smoke is the remaining manual gap.

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
