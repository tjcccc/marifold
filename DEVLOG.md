# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-06-21 — v0.20.0 — Per-profile default mode + TUI vertical-rhythm polish

- **Per-profile default mode.** `profile.toml` gains `mode = "agent" | "chat"` (parsed + validated in `ProfileResolver`; rejects anything else). `agent` stays the global default — a profile with no `mode` launches in agent. `resolveSettings` now surfaces `mode`, `runTui` passes it as the initial mode, and switching profiles adopts the target profile's default mode (the switch notice shows it).
- **`/agent` & `/chat` gain a `default` form.** Bare `/agent`/`/chat` switch the **current session** only (unchanged); `/agent default` / `/chat default` additionally **persist** to the active profile's `profile.toml` via new `ProfileManager.setMode` (an `upsertMode` writer that preserves every other key, symmetric with the model-override writer) exposed as `runtime.setProfileMode`. Persisting to a profile with no on-disk directory (e.g. the pure built-in `default`) reports a clear error — consistent with the existing model-override constraint.
- **Fix: run-clock reset on resize.** `RunStatus` unmounts during a resize burst (`!resizing && running`), so its `useState(Date.now())` restarted the elapsed counter at 0 on remount. The start time is now anchored in `App` (a ref above the resize gate) and passed in as `startedAt`, so the counter — and the seeded activity verb — survive a resize.
- **Fix: spacing around the run-summary footer + unified vertical rhythm.** Introduced `topGap(kind, prevKind)`: one blank line separates adjacent transcript items of **different** kind, while a run of same-kind items (e.g. a tool-call stream) stays tight. Applied in both render paths (the `<Static>` map and the `Transcript` component); replaces the old per-kind margin rules and the short-lived `notice.spaced` flag. Result: user → plan → tools(tight) → response → verify → time/token each get one blank, and the live region is separated from the committed transcript by a single blank.
- **Fix: stale `<Static>` header on mode switch.** The header (which shows mode) is append-only, so a bare `/chat`/`/agent` flipped only the live `StatusLine`. `setMode`/`setDefaultMode` now `repaint()` (same mechanism as profile-switch/Ctrl+L) so the top and bottom stay in sync.
- Version 0.19.0 → 0.20.0 across all packages + CLI `.version`.
- Verified: core 141 (+3 profile-mode parse/validate/round-trip), tui 27 (+1 mode-command routing), service 4 — all pass; all 4 packages build/typecheck green.
- **Open**: persisting a default mode requires the profile to have a directory on disk (built-in `default` with no folder can't be written to) — acceptable and consistent with model overrides, but a future scaffold-on-write could smooth it.

## 2026-06-20 — v0.19.0 — Markdown skills (SKILL.md folders) + TUI fixes

- **Skills are now markdown, Claude Code style.** `marifold.skill.v0` is a `SKILL.md` with a YAML frontmatter block (name/description/mode/variables) + a prompt body — no more TOML (TOML stays for config and the `skillapp` UI layout). New `yaml` dep in core; `schema:` is optional; `mode` defaults to `chat` (safest for weak local models). `SkillValidator` parses frontmatter+body.
- **Folder storage with bundled files.** Skills live at `<scope>/<name>/SKILL.md`. `/install-skill` accepts a `.md` file (saved as `<name>/SKILL.md`) **or** a skill folder containing `SKILL.md`, which is copied whole via `fs.cpSync` — bundled files (e.g. `vars.toml`) travel, though marifold currently only reads `SKILL.md`. Converted `examples/skills` (echo.md, summarize-file.md, translate/SKILL.md).
- **Scope-aware skill management.** `SkillStore.list`/`remove` take an optional scope; `/skills` manages the **profile** layer, `/skills --global` the **global** layer (Del removes only the viewed layer, so a shadowed global copy is reachable). Title cross-references the other layer; empty-state shows install hints. `/install-skill [--global]` installs to the current profile by default. The `$name` menu still shows the merged runnable set.
- **TUI fixes uncovered by testing:**
  - **Transcript resets were silently broken in the inline layout** — `<Static>` is append-only, so `/new`, `/clear`, **profile switch**, and session resume cleared the state but not the screen (and the new notice never rendered). Now any item *removal* (vs append) forces a clean repaint (remount `<Static>` + clear). New app-level integration test covers the profile picker + direct form.
  - `/profile <name>` direct switch (in addition to the picker) with a clear `Switched to profile: … (new session)` confirmation; the App-level Ctrl+L `useInput` is now inactive while an overlay/modal owns input.
  - Skill turns echo the **full invocation** (`$translate korean 晚上好！`), not just `$name`; head-token coloring for `$skill`/`/command` in both the input and the transcript (args stay default white) via a per-character color map in `InputBox`; LaTeX-free temps already handled.
  - Path args (`/install-skill`, `/read`, `/image`) strip surrounding quotes/backticks.
- Version 0.18.0 → 0.19.0 across all packages + CLI `.version`.
- Verified: core 138, tui 26, service 4 — all pass; all 4 packages build/typecheck green. End-to-end (built runtime): markdown + folder skills install/list/scope/remove; bundled `vars.toml` copied for the real `make-gpt-image-prompt` skill.
- **Open**: resets use a full clear (`\x1b[2J\x1b[3J\x1b[H`), which also wipes scrollback — a soft clear could preserve the previous session above; deferred pending preference. A `vars.toml`/`#name` skill-runtime (so folder skills run as designed) is a future feature.

## 2026-06-20 — v0.18.0 — Pluggable web search (Firecrawl BYOK) + autonomous model search

- **Provider-pluggable search.** `[web_search]` gains `provider` (`duckduckgo`|`firecrawl`, default duckduckgo), `api_key_env`/`api_key` (BYOK — prefer the env var), and `scrape`. New `src/search/FirecrawlBackend.ts` (Firecrawl `/v2/search`, Bearer or keyless, optional markdown scrape, best-effort proxy via optional `undici`) and `src/search/createSearchBackend.ts` factory; `MarifoldRuntime` selects the backend by config. DuckDuckGo stays the keyless best-effort floor. Hardened `resolveWebSearchConfig` so an absent key never clobbers a default.
- **Autonomous search; `/search` removed.** The model decides when to search via the `web_search` tool (chat + agent) instead of a manual command — matching Claude Code/Codex. Dropped `/search` from the TUI (`commands.ts`/`App.tsx`) and CLI (`chat.ts`). `enabled` is now the master switch for both modes; configuring a provider turns it on.
- **Fix: the agent never had `web_search`.** `createDefaultToolRegistry` registered read/write/shell/delegate but not search, so agent mode couldn't search at all (the model correctly reported "no web_search tool"). Now registered when `enabled` and `network` approval isn't `deny` — the agent tool list is built dynamically from the registry, so it surfaces to the model. (Caught only after live testing; the plan wrongly assumed agent mode already had it.)
- **Fix: LaTeX math rendered as raw source.** Models emit `$\text{23.2}^\circ\text{C}$` for temperatures; the terminal can't render math, so `Markdown.tsx` now normalizes inline `$…$`/`\(…\)` spans that contain LaTeX commands to plain unicode (`23.2°C`, `×`, `±`, `→`), leaving plain currency like `$30` untouched.
- **CLI:** `marifold config search` (interactive provider/key/scrape + `--provider/--api-key-env/--scrape/--enable/--disable`); `marifold init` gains scripted `--search-provider`/`--search-api-key-env`.
- Version 0.17.0 → 0.18.0 across all packages + CLI `.version`.
- Verified: core 134 (+8 `SearchProviders.test.ts`), tui 25 (+1 markdown-math), service 4; all packages build/typecheck green. End-to-end: `config search`/`init` write the section; the agent autonomously searches (Firecrawl) and a weather query renders `27/21°C` and passes verification.
- **Open**: tier-1 **native** provider search (Anthropic/OpenAI server-side `web_search`) is a future *priest* capability (the `provider` enum leaves a `native` seam); not built here. Small local models (gemma4:e4b) reliably call `web_search` but often hedge instead of committing, so the verify phase blocks them — a stronger model (qwen3.5:9b/cloud) is needed for confident answers. No automated test for the agent-registry wiring (test infra builds runners from explicit tools); verified via build output + manual run.

## 2026-06-20 — v0.17.0 — Inline TUI with resize-clean rendering (reverses alt-screen)

- **Back to inline, deliberately.** Reverted v0.16.0's alternate-screen layout — it felt "too serious," took over the terminal, and cleared on launch. The TUI again renders inline: `<Static>` banner + transcript in native scrollback (scrollable, copyable, survives exit) + a small live composer. Removed the full-height frame, `src/core/transcriptWindow.ts`, the `PgUp`/`PgDn` windowing, and the on-exit reprint (redundant when history is already in scrollback).
- **The resize fix (the long-standing duplication), in two layers:** (1) `src/ui/useResizing.ts` — during a resize burst the live region collapses to a single `↔ resizing…` line (input stays mounted, typed text preserved, typing ignored), so Ink has nothing multi-line to mis-erase while the terminal reflows/scrolls scrollback; (2) a full clean repaint on resize-settle **and on Ctrl+L** — clear the screen and bump the `<Static>` key so Ink re-emits the whole transcript from the top, wiping any lines the terminal stranded mid-reflow.
- Grounded in Ink 7.0.5 source: its `resized` handler clears the live region only on width-*decrease* and never reflows committed `<Static>` scrollback (`renderInteractiveFrame`/`shouldClearTerminalForFrame`) — so app-level detection can't beat it, only collapse-then-repaint works. Confirmed the shipped Claude Code binary is **Ink + React + Yoga, Bun-compiled** — same engine, same constraints.
- **Strategy recorded:** evaluated rewriting the CLI in Rust (ratatui + priest-rs) to fix resize / ship a single binary — **rejected**. Keep one load-bearing priest implementation (priest-ts) so CLI + future WebUI + types stay unified; `bun build --compile` already yields a single native binary. Rich fixed-width chrome + inline + clean-resize is an impossible triangle, so the rich/robust UI is deferred to the macOS/iOS GUI (the real flagship).
- Version 0.16.0 → 0.17.0 across all packages + CLI `.version`.
- **Verified live by the user** (first time resize was real-TTY tested): clean shrink/enlarge, Ctrl+L refresh, long wrapped input surviving resize. Local: tui 24 tests + typecheck + build green.
- **Open**: the settle/Ctrl+L repaint uses a full clear, so the shell prompt line above marifold is cleared too (could soften to preserve scrollback). The header is still a `<Static>` border box that shatters mid-drag on shrink, but the settle-repaint cleans it; a plain-text header would avoid the transient. Auto-repaint-on-every-resize could be made Ctrl+L-only if it feels heavy.

## 2026-06-19 — v0.16.0 — Fullscreen TUI, agent session, in-transcript info

- **Alternate-screen layout** (`render(..., { alternateScreen: true })`): full-height frame — banner pinned top, transcript windowed in the middle, input/status pinned bottom — so terminal **resize redraws cleanly** (the inline `<Static>` reflow duplicated rows; the alt-screen is how vim/htop/Codex avoid it). New `src/core/transcriptWindow.ts` (explicit fit windowing, Ink's `overflow` clipping is unreliable) + `src/ui/useTerminalSize.ts`; `PgUp`/`PgDn` scroll history; on exit the conversation is reprinted to the normal buffer (commands excluded). Header has 1-col internal padding; status sits at the bottom row.
- Investigated the root cause in Ink 7 source: it clears the live region on width-decrease but can't track `<Static>` scrollback reflow — hence the duplication. Plan B (plain-text input rules vs Ink border box) didn't fix it; alt-screen did. Resize is unverified in the harness (no real TTY).
- **Agent session**: `AgentRunOptions.sessionId` threaded into the main loop turns (not plan/verify) as a priest session, so agent mode **remembers earlier turns**; chat and agent share one conversation session. `/status` shows a real session id. Test asserts the session lands on the loop turn only.
- **Info commands in the transcript**: `/status`, `/help`, `/permissions`, `/doctor` now print into the conversation (and stay) instead of a dismissable modal — labeled by the `/command` echo divider. Removed `InfoPanel`. Interactive pickers + approval stay overlays.
- Version 0.15.0 → 0.16.0 across all packages + CLI.
- Verified: core 126 + tui 24 tests, all packages build/typecheck green; behaviors via Ink frame dumps.
- **Open**: alt-screen clears on launch / restores on exit (vim/htop/Codex behavior; user is weighing an inline↔alt-screen hybrid — Ink can't toggle `alternateScreen` live, so that needs lifting state out + remount). Agent session stores the verbose loop prompt as its turn (functional, could persist a clean objective instead).

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
