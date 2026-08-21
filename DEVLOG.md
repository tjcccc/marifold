# DEVLOG

Cross-session development log. Newest first. Keep entries short: what shipped, what was verified, what's open.

## 2026-08-21 — v0.56.1 — Idempotent empty-session creation

- Made Web `New session` idempotent while the active GUID has no corresponding
  database session. Optimistic `Saving…` rows and filtered sidebar results do
  not count as persistence; successful session detail/list responses do.
- Preserved normal new-session creation once the active session is confirmed
  durable, with a controller regression covering both sides of the boundary.
- Verified 127 CLI command checks and the full workspace typecheck/build/test
  gate (618 tests: core 306, service 55, TUI 59, CLI 18, Web 180).
- Version 0.56.0 → 0.56.1 across all packages + CLI `.version`.
- Released as v0.56.1.

## 2026-08-21 — v0.56.0 — Managed service daemon lifecycle

- Added equivalent foreground `marifold service` / `marifold service start`
  entry points plus detached `marifold service start --daemon` execution.
- Added single-instance state, stale-state recovery, graceful
  `marifold service stop`, `marifold status`, and a bounded
  `marifold status --logs` daemon tail.
- Kept `--log` as Fastify request logging in both modes; daemon stdout/stderr is
  stored under `~/.marifold/service/service.log`.
- Added spawned-process regressions for foreground deduplication/status and the
  complete daemon start/status/log/deduplicate/stop lifecycle.
- Verified 127 CLI command checks and the full workspace typecheck/build/test
  gate (618 tests: core 306, service 55, TUI 59, CLI 18, Web 180).
- Version 0.55.0 → 0.56.0 across all packages + CLI `.version`.
- Released as v0.56.0.

## 2026-08-20 — v0.55.0 — Web response control and multi-select questions

- Added a ChatGPT-style Stop control to the Web composer while either a plain
  chat stream or agent run is responding. Agent mode uses the existing run
  cancellation route; chat mode aborts the SSE request and keeps received
  partial text without misclassifying the cancelled exchange as durable.
- Added Web component, reducer, and controller regressions for both cancellation
  paths.
- Extended `ask_user` with opt-in `multiple: true` questions. The core validates
  and normalizes several selected option ids plus optional custom text, while
  preserving single-select defaults and accepting a legacy single `optionId`
  for a multi-select question.
- Added checkbox interaction to the Web question sheet and keyboard toggle
  interaction to the TUI modal, with core, service, Web, and TUI regressions and
  updated API/client documentation.
- Verified the full workspace typecheck/build/test gate (614 tests: core 306,
  service 55, TUI 59, CLI 14, Web 180).
- Version 0.54.0 → 0.55.0 across all packages + CLI `.version`.
- Aligned the live agent contract, README, architecture/service documentation, TODOs, and `.projnavi` notes with the post-v0.24.2 runtime: observable checks run through ordinary tools inside the loop, with no separate model self-grading call. The legacy `AgentEvent.verification` variant remains deprecated compatibility surface, while the generic TaskStore event name is reserved for explicit evidence from future producers.
- Added focused-check guidance to ordinary agent context and standardized every built-in tool description on explicit “When to use” / “When NOT to use” affordances without changing permission or execution policy.
- Removed stale scripted verification responses, added a regression covering all seven built-in tool descriptions, and tightened the optional provider-backed agent eval around direct-answer and dedicated file-tool selection.
- Recorded the deferred context, Workflow, external-agent/ACP, MCP, checkpoint, and durable-process work in `TODO.md` with product triggers, ownership boundaries, and explicit non-goals. Marifold remains a lightweight local-first personal AI workspace, not a heavyweight coding agent or general agent SDK.
- Verified `scripts/agent-eval.mjs` syntax plus the full workspace typecheck/build/test gate (607 tests: core 305, service 55, TUI 58, CLI 14, Web 175). The optional live-provider agent eval was not run because it requires a configured model.
- Released as v0.55.0.

## 2026-08-10 — v0.54.0 — Optional agent clarification questions

- Added the interaction-only `ask_user` agent tool. Models are instructed to use it only when essential information is missing; ordinary work proceeds without a question checkpoint. Requests are bounded to one–three questions with validated suggested options and one complete submission.
- Added renderer-neutral `user_input_request` / `user_input_response` events, live-run pending state, and `POST /v1/runs/:id/inputs/:requestId`. Clarifications remain separate from permissions, resume the same run, time out safely, and fail immediately in unattended contexts.
- Added a standalone inline Web question sheet (suggested choices, “Something else,” one final Submit) and a keyboard TUI modal, with core/service/reducer/component/end-to-end coverage.
- Fixed the TUI custom-answer cursor leaking into other questions. Clarified the shell contract so models use `write_file` for explicit destinations outside the shell sandbox instead of attempting redirection that approval cannot make writable.
- Kept ordinary failed/cancelled agent prompts durable as clean session pairs with an explicit terminal outcome, while failed historical regenerations preserve the existing successful exchange.
- Restored normal `~` and `$HOME` handling for agent file tools, shell commands, and model context. The disposable per-run home remains internal runtime state, while writes outside the working/trusted folders continue through the existing approval and sandbox boundaries.
- Added focused regressions for path resolution, approval targeting, file placement, shell environment expansion, and agent instructions.
- Verified by the user in both TUI and Web UI, plus the full workspace typecheck, production build, and test gate (606 tests: core 304, service 55, TUI 58, CLI 14, Web 175), including the macOS Seatbelt integration checks.
- Released as v0.54.0.

## 2026-08-03 — v0.53.1 — xAI OAuth proxy resilience

- Routed xAI browser token exchange through the saved per-provider proxy, with the existing HTTP(S)_PROXY fallback.
- Added bounded retries for transient xAI token exchange and refresh transport failures such as `ECONNRESET`; HTTP responses remain single-attempt so rejected or consumed authorization codes are not replayed.
- Added focused retry and proxy-forwarding regressions and verified live reachability of `auth.x.ai` through the configured proxy without sending credentials.
- Standardized Web reauthentication copy and product documentation on installed commands such as `marifold provider reauth xai`; `pnpm` remains limited to source-workspace build and test workflows.
- Verified the full workspace typecheck/build/test gate (587 tests), 124 CLI command checks, and the built CLI version output.
- Released as v0.53.1.

## 2026-08-02 — v0.53.0 — Authenticated remote service binding and switching

- Kept `127.0.0.1:32140` as the default while allowing explicit non-loopback `--host` values only when bearer authentication resolves from config or CLI flags.
- Allowed the hosted Web UI to call the API same-origin through a LAN or Tailscale IP without a redundant Connection URL or CORS entry; cross-origin browsers remain exact-allowlist gated.
- Replaced the one-off Web connection fields with named Marifold servers: **This server** stays same-origin, remote entries retain independent URLs/tokens, and activation requires a compatible `/v1/status` response.
- Remounted the Web data surface on connection changes and namespaced last Agent routes and drafts by server so profiles, sessions, and in-flight state cannot carry across a switch.
- Added a two-service Chromium regression that switches from the local fixture to a token-protected remote service and back.
- Documented direct `--host 0.0.0.0` access, its all-interface exposure, and the narrower specific-address option.
- Verified the full workspace typecheck/build/test gate (581 tests), all eight Chromium workspace scenarios including remote switch/reload/switch-back, a real wildcard socket bind, and 124 CLI command checks.
- Released as v0.53.0.

## 2026-07-27 — v0.52.0 — Global Apps and multi-profile actors

- Fixed bundle-free Skill and App prompts so they no longer advertise a nonexistent `vars.toml` or unavailable `read_file` action; actual bundled skills now name only the files they carry.
- Replaced the unreleased profile-scoped SkillApp prototype with `marifold.app.v0`: global `<apps_dir>/<name>/app.toml` bundles, explicit multi-profile actors, `/v1/apps`, actor-owned Skill resolution, and App actions that never replay or write Agent transcripts.
- Kept Agent and Apps inside one persistent Web workspace shell: switching tabs replaces only the sidebar catalog body and right-pane content, so the Marifold brand, system footer, sidebar width/visibility, and header controls do not remount.
- Reused the complete Agent profile-sidebar and thread-header chrome for Apps: `Search apps`, avatar-style rows, selected state, the same resizable width as Profiles, and the same full-width sidebar toggle beside the `Apps` title. The Apps pane renders no profile/session list, transcript, or composer.
- Verified the App replacement with the full workspace typecheck/build/test gate (573 tests), a two-actor service regression, and a headed Chromium pass across direct `/apps` loading plus Agent → Apps navigation.
- Adopted published `@priest-ai/core` 3.0.0 and delegated OpenAI-compatible Responses transport to its provider implementation while retaining Marifold-owned routing, OAuth headers, proxy selection, and ChatGPT's SSE-only behavior.
- Replaced product-side `think` branching with Priest's provider-neutral reasoning configuration where supported; Bailian-compatible legacy options remain isolated at the compatibility edge.
- Preserved safe reasoning summaries, opaque continuation across tool turns, and cached/reasoning usage through core, CLI, TUI, service SSE, and Web renderers without exposing private provider traces.
- Fixed the TUI's two-column prompt gutter under wrapping pressure: submitted prompts retain the space after `>`, while live-input continuation lines no longer inherit a separator space that lands exactly on the automatic wrap boundary.
- Made TUI session resume strictly recency-ordered. Web UI pins remain a Web display preference and no longer promote older sessions in the TUI picker or bare `marifold --resume` selection.
- Enlarged the browser favicon to match the in-app marigold mark and standardized Web development on the explicit IPv4 loopback origin `http://127.0.0.1:5173`, avoiding `localhost` resolver and address-family ambiguity.
- Raised the supported runtime to Node 24 LTS and refreshed the stable dependency surface: React 19.2.8, Ink 7.1.1, Sharp 0.35.3, Fastify 5.10, Undici 7.28, Commander 15, Vite 8.1 with plugin-react 6, Vitest 4.1, Playwright 1.62, smol-toml 1.7, Node 24 types, and pnpm 11.17. Undici stays on Node 24's dispatcher-compatible major so proxied OAuth and provider calls work with the built-in `fetch`; a local proxy regression test guards that boundary. Vitest JSX transforms now use Vite 8's Oxc configuration instead of the deprecated esbuild compatibility path.
- Aligned `better-sqlite3` 13.0.1 with Priest so one native SQLite implementation owns session databases; loading majors 11 and 13 in the same process produced corruption symptoms. The production dependency audit now reports zero advisories.
- Added guarded provider removal to Web Config and the service API: typed confirmation clears local credentials/config plus saved model options, while global-default and profile-override references block deletion. `marifold provider reauth` now replaces GitHub Copilot, ChatGPT, or xAI OAuth credentials without deleting provider settings/models; Web Config exposes the copyable host-local command. Expired OAuth access tokens trigger fresh setup, and the Service page correctly reports environment-resolved bearer authentication.
- Added completion metadata to plain Web chat streams: successful `done` events carry end-to-end latency and provider-reported usage, and chat responses now show the same time, token, reasoning, and estimated-cost footer as agent responses.
- Persisted unified chat/agent response metrics in a Marifold-owned SQLite companion table keyed by stable session/user-turn ordinal. Reloaded transcripts retain timing, provider/model, thinking, token/cache/reasoning, and estimated-cost data; edit, rename, truncate, clear, and delete lifecycle operations keep metrics aligned for future statistics.
- Added the first App MVP: global TOML bundle discovery, normalized service-owned definitions, renderer-neutral nested row/column layouts, typed state, streamed chat-mode actor Skill actions, and a generic Web Apps renderer. Per-app `think`, `memory`, and `profile_context` controls default off for focused low-cost runs.
- Added an `app_tester` actor profile using `xai/grok-4.5` with a global translation App. Credentials remain outside the fixture, and automated coverage substitutes a fake provider while verifying actor/Skill resolution, context suppression, SSE output, Web rendering, and transcript isolation.
- Added visually hideable-but-accessible form labels and a flexible `spacer` layout component, then moved the translator's language selector above the editors and centered its action with `spacer → button → spacer`.
- Added provider-wire, chat/agent tool-loop, usage-accounting, service SSE, TUI, Web stream, and renderer regression coverage. The published-package workspace gate passes 566 tests plus 124 CLI command checks; the Priest artifact also passed TypeScript 5.9/7 consumer types, CJS/ESM, Node 18/20/22/24 imports, and a Node 24 SQLite check.
- Released as v0.52.0 after the full workspace gate and browser smoke pass.

## 2026-07-26 — v0.51.1 — TypeScript 7 native compiler

- Upgraded every workspace from TypeScript 5.9.3 to TypeScript 7.0.2, including the native platform compiler packages in the pnpm lockfile.
- Replaced the removed legacy Node module resolver with `NodeNext` for core, service, and CLI builds. TUI remains on `NodeNext`, while the Vite WebUI retains its `Bundler` override.
- Verified the frozen install, full workspace typecheck/build/test gate (547 tests), React WebUI production bundle, and 123 CLI command smoke checks. The full workspace typecheck completes in about 0.68 seconds on the development machine.

## 2026-07-24 — v0.51.0 — Direct skills and contact-style profiles

- Web/service `$skill [args]` turns now resolve the selected profile/global skill in core before model execution instead of asking the agent to search filesystem paths. Expanded instructions and the exact bundled-file directory are request-scoped, while the original invocation remains in durable transcript history.
- Direct skills are history-isolated in both agent and declared-chat modes, preventing one prompt skill's output style from leaking into the next. Agent skills use the lean path; chat skills append a clean visible exchange without replaying the session to the provider.
- Active profile and configured global skill directories are narrow read-only run roots. A skill can read its own `SKILL.md`/bundled files without approval, while other `~/.marifold` state, external configured paths, and all writes remain protected.
- Reworked the Web profile sidebar into a compact contact list with 40 px avatars, the latest response's first-line preview and relative activity time, recent-session ordering, and persistent profile pinning. Profile/session pins now share one glyph.
- Added an accessible hover/focus profile menu with Pin/Unpin and Config actions. Returning to the profile list refreshes activity metadata so completed conversations move immediately.
- Added double-confirmed profile removal to Config and the service API. The popup requires the exact profile name before enabling the final destructive action. Removal deletes the stored profile's instructions, memories, skills, and avatar while preserving session history; the built-in/current-default profile and profiles with active requests are protected.
- Tightened the marigold mark's SVG viewBox and brand padding so the artwork fills its slot without oversized internal whitespace.
- Added core, service, Web-controller, session-persistence, sandbox, Web API/component, and destructive-action regression coverage.
- Verified with the full workspace typecheck/build/test gate (547 tests) and five isolated Chromium workflows.

## 2026-07-23 — v0.50.0 — Safe agent files and execution

- Added Web composer support for modern Word (`.docx`), Excel (`.xlsx`), and PowerPoint (`.pptx`) files. Browser-local OOXML extraction preserves useful paragraph/slide/sheet structure with bounded archive, expanded-XML, and prompt-text limits; malformed, encrypted, empty, oversized, and legacy files fail clearly.
- Text/Office attachment chips reconstruct from durable prompts for historical edit/resend. Chat sends extracted text only; agent mode additionally stages original text/Office files read-only under a private run input directory.
- Every agent run now owns `~/.marifold/runs/<run-id>/` with a synthetic home, input/work/output/temp/cache directories, and a disposable `.venv`.
- Replaced direct host shell execution with a fail-closed macOS Seatbelt boundary: network and host writes outside explicit capabilities are denied, along with broad/sensitive roots, unrelated signals, Apple Events, clipboard/Launch Services mutation, and keychain IPC.
- Added `python_package_install`: one-time-approved, registry-only `uv` installs into the run environment. Package build hooks cannot read uploads, the repository, or trusted host folders; global Python installs remain blocked.
- External filesystem actions require fresh approval regardless of saved kind grants and cannot become persistent “Always allow” or “Trust” decisions. CLI `--yes`, TUI, Web, service, and Telegram honor the non-persistable contract.
- `marifold service` now cleans up and exits deterministically on SIGINT/SIGTERM, forces stuck shutdowns after five seconds or a second signal, and tears down newly created runtime owners after bind failures instead of leaving ghost processes.
- Extended the service/Web run contract for bounded original-file staging, updated the security/API/TUI documentation, and preserved the intentionally deferred App runtime boundary.
- Verified with the full workspace typecheck/build/test gate (532 tests), four isolated Chromium workflows, actual macOS sandbox/`uv` integration checks, and a spawned service lifecycle regression covering duplicate bind, SIGINT exit, and port release.

## 2026-07-23 — v0.49.0 — Web workspace completion

- Hardened session lifecycle behavior: optimistic first-turn rows no longer offer premature durable actions, deleting an active agent/chat session cancels and waits for its request, and the service refuses destructive history changes while a run or plain chat request is active so late persistence cannot recreate deleted history.
- Added server-backed active/archived session views and title/first-prompt search. Archive state migrates the v0.48 display table in place and remains separate from transcript/model context.
- Added a Messages-style profile filter for users who organize many projects as profiles. Matching is instant, case-insensitive, Unicode-normalized, and keyboard-accessible.
- Replaced base64-heavy session-detail responses with stable attachment references and authenticated binary delivery. Transcript thumbnails load near the viewport, full-screen previews load the selected image on demand, and historical resend can recover the referenced bytes.
- Added per-session composer text persistence and attachment isolation, keyboard navigation for session menus, focus trapping/restoration and scroll locking for dialogs, plus Config pages for global agent defaults, web search, and appearance.
- Added isolated real-browser regression coverage and refreshed the Web/API/roadmap documentation. The full workspace gate passes 506 tests, with three additional Chromium workflows covering the completed surface. Apps remained intentionally deferred for their own design pass.

## 2026-07-23 — v0.48.0 — Durable Web transcript and session controls

- Web transcript images now survive session reloads as display-only attachments, open in a large dimmed preview, and support previous/next navigation for multi-image messages. Composer attachment thumbnails use the same preview before submission; none of these display assets are injected into later model context.
- Historical user prompts now expose hover-only copy/edit actions. Editing regenerates the selected user→assistant exchange from only its preceding context and replaces it in place, preserving all later exchanges and stable transcript order instead of truncating the session or appending a misleading new turn.
- Added ChatGPT-style response and fenced-code copying, code-block language headers, 16 px transcript text, 14 px sidebar text, and a title-only thread header. Composer fixes prevent Enter during CJK IME composition from submitting and keep the caret/typed closing fence visible after pasting long JSON/code.
- Session rows now expose Rename, Pin/Unpin, and confirmed Delete actions. Custom titles and pin state persist in a Marifold-owned companion table so a later Priest model save cannot overwrite them; pinned rows sort first without changing transcript recency or `--resume last`.
- Extended the service/core contract for display-only image replay, in-place historical exchange replacement, and sidebar display metadata. Updated the API documentation and added regression coverage across core, service, Web state, controller, input, transcript, and component flows.
- Verified with the full workspace `typecheck && build && test` gate (496 tests: core 258, service 40, TUI 50, CLI 10, Web 138). The rebuilt loopback service passed `/health`; live visual browser automation was unavailable in this environment, while the interaction-level component tests passed.

## 2026-07-22 — v0.47.1 — Web conversation rendering and follow behavior

- Web Markdown now honors explicit hard breaks (`two trailing spaces` or `\\` before a newline) without converting ordinary soft line wraps into `<br>` elements.
- Submitting from the middle of a conversation explicitly repins the transcript to the bottom; manually scrolling up afterward still pauses auto-follow during streamed/background updates.
- Verified with Web typecheck/build and 123 tests, plus a real-browser pass on the reported Japanese session and a local `/status` submission from exact mid-scroll (no model request).

## 2026-07-22 — v0.47.0 — macOS-style Web application shell

- Replaced the full-width management-style header with a desktop application frame: one primary sidebar and a contextual toolbar owned by the right workspace. The sidebar starts at 256 px, is pointer- and keyboard-resizable from 200 px to 40% of the workspace, and persists the user's width across Agent, Apps, and Settings. Agent/Apps switches only the right content and preserves the active profile/session context.
- Refined that desktop frame after visual review: the thread toolbar is now a single title row with Agent/Apps at the trailing edge, the root Marifold identity is larger, and Connection opens as a centered modal sheet instead of an unrelated top-right popover.
- The primary sidebar is a navigation stack instead of two simultaneous columns. Its root shows the Marifold identity and profiles; choosing a profile slides forward to its sessions, with an explicit back control and a large profile avatar above the Sessions heading instead of a small avatar in the back row. Connection, appearance, and Settings remain fixed at the bottom in both states.
- Settings now opens as a dedicated system surface and returns to the previous agent route; that route also survives Apps/Settings reloads for continuity. Windows below 900 px show an explicit desktop-width notice instead of an incomplete mobile layout.
- The root Agent route now stays on the profile picker instead of automatically opening the configured default profile; explicit profile/session links still open their requested destination.
- Web navigation now uses clean History API paths such as `/agent`, `/apps`, and `/config/profiles/default`; the service's existing extensionless-route fallback keeps direct loads working, while old `#/…` bookmarks migrate to their canonical clean URL on load.
- Agent `text` events now distinguish pre-tool `progress` commentary from the `final` answer. Web and TUI render progress in secondary gray while keeping the result at normal emphasis (the CLI dims it too); older phase-less events remain final for wire compatibility.
- Web and TUI skill/command completion now follows the caret while editing the leading token even when existing arguments remain, so deleting or replacing `$make-midjourney-prompt` reopens candidates without discarding the rest of the prompt.
- Shifted sidebar/surface colors from warm beige to neutral macOS-like grays in light and dark appearances while retaining marigold as the sole product accent. Sidebar motion respects reduced-motion preferences.
- Verified with the full workspace `typecheck && build && test` gate (470 tests: core 252, service 38, TUI 50, CLI 10, web 120) plus real-browser Playwright checks at desktop/narrow widths, in light/dark appearances, for sidebar resizing and the Sessions avatar layout, clean routing, trailing workspace tabs, the centered Connection sheet, and reopening/replacing a skill token while preserving its existing arguments.

## 2026-07-22 — v0.46.1 — Web UI rendering and session fixes

- The dependency-free Web Markdown renderer now recognizes GFM-style pipe tables, including column alignment markers, inline formatting, escaped pipes, and code spans containing pipes. Tables render as semantic HTML with bounded horizontal scrolling instead of collapsing into a single paragraph.
- Tab/Enter autocomplete now places the textarea caret explicitly after the completed `$skill ` or `/command ` token. The live highlight mirror also keeps the textarea's font weight, eliminating the width mismatch that made an end-positioned caret appear before the last character; submitted bubbles retain their bold highlight.
- A first message now adds its newly generated session to the sidebar immediately with a one-turn prompt preview. Agent-run followers refresh from the authoritative server session list on `done`, fixing completed agent sessions remaining invisible until a reload or profile switch; failed run starts also discard pending rows through the same refresh path.
- Full workspace `typecheck && build && test` gate green (459 tests: core 252, service 38, TUI 49, CLI 10, web 110).

## 2026-07-21 — v0.46.0 — Image request optimization

- TUI, CLI, service chat, and live agent runs now share a core image-preparation boundary: validate/decode, correct MIME types, cap requests at four images and 16 MiB of local/base64 source data, auto-orient, resize to a 1600 px long edge, strip metadata, and retain the optimized output only when smaller. Lossless sources and transparency use lossless WebP; JPEG and oversized static WebP use conservative high-quality fallbacks only when needed; animated images and remote URLs remain untouched.
- Web UI preprocesses large JPEG/PNG attachments before base64/state/service transport, retains the source as a Blob-backed `File` for a one-turn bypass, and shows original → optimized size on the attachment tooltip. `/attach-original <prompt>` in both TUI and Web UI bypasses encoding/resizing for that message only while retaining validation and caps.
- Added `sharp` 0.34.x (the newest line compatible with the Node 18 project floor) plus core/browser/command/service coverage. Full workspace `typecheck && build && test` gate green (450 tests: core 252, service 38, TUI 49, CLI 10, web 101).

## 2026-07-18 — v0.45.1 — TUI Delete semantics + interactive `/resume`

- Fixed Fedora's Del (`ESC[3~`) in the TUI composer so it forward-deletes the character under the cursor; Backspace continues to delete the character before it, including the macOS `0x7f` byte.
- Added canonical `/resume` with a recent-session picker showing conversation preview, recency, turn count, and the current session. The existing `/session` form remains a compatibility alias, and command aliases are now discoverable in autocomplete.
- Copy-on-select remains terminal-owned by design: native terminal scrollback does not expose selection text or selection events to an inline Ink application, so Marifold keeps the deterministic `/copy` command rather than adding a non-portable toggle.
- Verified: full workspace `typecheck && build && test` gate green (439 tests: core 246, service 38, TUI 47, CLI 10, web 98). Real Fedora terminal smoke remains recommended for the Del escape sequence.

## 2026-07-16 — v0.45.0 — Lazy built-in skill-manager guide

- Ordinary non-lean agent objectives that mention `skill`/`skills` or common Chinese, Japanese, Korean, Spanish, French, German, Portuguese, or Russian equivalents now receive a concise built-in `$skill-manager` guide. It includes the resolved active-profile and configured global skill directories, defaults changes to profile scope, explains shadowing, and explicitly prevents `.claude/skills`, `.agents/skills`, or working-directory skill installs.
- The guide stays out of explicit `$skill` runs so it cannot pollute a skill's authoritative instructions. `/install-skill` behavior is now documented precisely: reinstall updates, a folder source replaces the folder, and uninstall remains `/skills` + Del at the selected scope.
- Full `typecheck && build && test` gate green. Tests cover multilingual detection and boundaries, rendered paths, normal-vs-lean agent injection, and runtime-to-Priest system-context wiring.

## 2026-07-10 — v0.44.1 — Composer: two-row layout (ChatGPT-style)

Fixes the "big right padding" the user hit with multi-line input. Two causes, both fixed:

- **Textarea width** — `.inputWrap` was `display: flex`, and a `<textarea>` flex item doesn't reliably honor `width: 100%` (falls back to intrinsic cols width). Now a plain block wrapper + `display: block; width: 100%` textarea; the native scrollbar is hidden (it shrank the text column and misaligned the caret from the v0.43.0 highlight overlay — long content still scrolls, overlay synced); wrapping rules (`pre-wrap`/`break-word`) unified across textarea and highlight so CJK/`#tokens` wrap identically.
- **Layout** — the real dead space: Think/model/send sat inline in the same flex row, reserving a full-height right column beside a tall input. Restructured to **two rows** (the user's ChatGPT reference): textarea spans the full width; `+` attach bottom-left, controls pinned bottom-right (`.bottomRow`, `.controls { margin-left: auto }`).
- Verified: web typecheck/tests/build green, plus **headless-Chrome screenshots** — an old-vs-new CSS repro with the user's tall CJK text (full-width flow, no dead column) and the **live served app** on the real service (new composer renders; migrated avatars visible). Diagnosis detour worth remembering: the service serves `web_dir` → repo `apps/web/dist`, so "not fixed" reports were a stale SPA tab — check the served asset hash before touching code.

## 2026-07-10 — v0.44.0 — Web UI: /command palette (15 commands)

Brings the TUI's `/command` layer to the composer, reusing the `$skill` autocomplete/highlight infra generalized over both sigils (`lib/commandSyntax`: `menuQuery`/`splitLeading`/`parseCommand` + a static `WEB_COMMANDS` list). Typing `/` opens the same keyboard-navigable menu.

- **15 commands**, wired to real actions: `/help /status /copy /retry /new /agent /chat /think /model <id> /btw <text> /stop /remember <text> /forget <query> /context-window /compact`. Unknown → notice, nothing sent. Command handling runs **before** steering, so `/stop`/`/btw` act on a live run instead of steering-as-text. A path like `/a/b` is not treated as a command (word-boundary rule).
- **Execution** lives in `useAgentController.runCommand`; the message path was extracted **verbatim** into `sendMessage` (so `/retry` re-runs the last message and `send` dispatches command-vs-message without touching the load-bearing steering/attachments/chat-vs-agent logic).
- **2 new endpoints** (thin, mirroring existing routes): `POST /v1/profiles/:name/memories` (`/remember`) and `POST /v1/sessions/:id/compact` (`/compact`); web `rememberMemory`/`compactSession`. `/forget` reuses list + delete-by-id (substring match). `/copy` uses the clipboard; `/status` reads controller state.
- **`/help` rendering fixed** — multi-line notices render as a left-aligned block (`white-space: pre-line`) instead of collapsing into a run-on pill.
- **Deliberate choices:** `/context-window` is **show-only** (changing the global budget from chat would silently affect every profile — left to Config); `/agent`/`/chat` **persist to the profile** (the web has no session-only mode; same as the Config toggle).
- Verified: full `typecheck && build && test` green. Tests: `commandSyntax` (15-command set, path/boundary parsing), `InputBar` (`/` menu + completion past the 8-item cap), `/remember` endpoint. **Not unit-tested** (need a browser/live pass): `runCommand` execution and `/compact` (needs a live provider).

## 2026-07-10 — v0.43.1 — Web UI fixes from the browser pass

Follow-ups to v0.42/0.43 after a real browser pass:

- **Autocomplete scroll** — the `$` menu now scrolls the highlighted suggestion into view on ↑↓ (`scrollIntoView({ block: 'nearest' })`), so it no longer disappears below the fold after a few Downs.
- **Avatar storage — clean break** — dropped the legacy root-`avatar.*` read/clean fallback; `assets/avatar.<ext>` is now the only location. Migrated the user's existing root avatars (`friend`, `x-runner`) into `assets/` and verified all avatars resolve. `findProfileAvatar`/`removeAvatarFiles` are assets-only; the migration test became an "ignores root avatars" test.
- **Avatar bigger** — 96 → **120px** on the profile page.
- **Remove-photo hidden** — the conspicuous red "Remove photo" link is gone from the profile header (deletion stays available via runtime/CLI; re-add later if wanted).
- Verified: full gate green; +1 InputBar scroll test; ProfileResolver avatar tests updated. Real-data check: `friend`/`painter`/`x-runner` avatars resolve from `assets/`.

## 2026-07-10 — v0.43.0 — Web UI: $skill highlight + autocomplete

Brings the TUI's `$skill` composer affordances to the browser (the `/command` half is deferred — the web has no slash-command handler yet).

- **New endpoint** `GET /v1/skills?profile=` — available skills (name, description, `usage` like `$translate <text> [language]`) from `runtime.listSkills`, profile-scoped so profile skills shadow global. Web `getSkills` + `SkillHint`; the agent controller fetches them alongside profile detail and passes them to the composer.
- **Inline highlight** — the leading `$skill` token is colored (brand) both while typing and in submitted user bubbles. In the composer this uses the standard transparent-textarea-over-a-styled-mirror overlay (shared font metrics; scroll synced); `ThreadView` highlights the same token in user bubbles. Shared grammar in `lib/commandSyntax` (`leadingSkillToken`/`skillQuery`/`splitLeadingSkill`).
- **Autocomplete** — typing `$` opens a keyboard-navigable menu (filters as you type, ↑↓ to move, Tab/Enter to complete the name, Esc to dismiss, click to insert), matching the TUI. Closes once a space (args) follows the name.
- Verified: full `typecheck && build && test` green. +4 `commandSyntax` unit tests, +4 `InputBar` autocomplete tests (filter/complete/arrow-nav/plain-submit), +1 service `/v1/skills` test. **Not browser-verified** — the overlay's caret alignment is CSS-metric-dependent and needs a visual pass.

## 2026-07-10 — v0.42.0 — Web UI polish: avatar crop/compress + header logo

- **Header logo** — mark 28→**32px**, brand gap 8→**4px** (`TopNav`).
- **Avatar, Apple/social style** (`ProfileSettingsPage`) — the profile identity header is now a **centered** column with a **96px avatar** that reveals an edit overlay on hover; clicking opens the file picker. Selecting an image opens a new **`AvatarCropper`** modal (drag to reposition, zoom slider, circular preview); on save it draws the visible square to a 512² canvas and exports a **lossless PNG**, so large inputs are downscaled on save while the stored file stays small. Flows through the existing `onAvatarPick(File)` → `putAvatar` path unchanged.
- **Avatar storage** (`ProfileManager`) — moved from the profile root to **`<profile>/assets/avatar.<ext>`** so binaries don't sit next to `profile.md`/`rules.md`; `findProfileAvatar` still reads a **legacy root-level** `avatar.*` for back-compat, and a re-upload migrates it into `assets/`. Size ceiling 1 MB → **2 MB** (guards the processed 512² PNG). Only `apps/web`'s profile page routes through the cropper; the CLI/create-sheet upload paths are unchanged.
- Verified: full `typecheck && build && test` green. Core avatar test updated (asserts `assets/avatar.png`, 2 MB limit) + new back-compat/migration test; web + service suites pass. **Not browser-verified** — the canvas crop can't run under jsdom; needs a visual pass. (`$`/`/` input highlighting + autocomplete is the next task.)

## 2026-07-10 — v0.41.0 — Web UI: per-provider proxy field

Exposes the v0.40.0 per-provider `proxy` setting in the browser Config → Providers page, for parity with the CLI (`config set providers.<name>.proxy`).

- **Service** — `publicProvider` (the sanitized `/v1/config` view) now includes `proxy` when set. It's a non-secret URL exposed in the clear like `base_url` (not a boolean like `hasApiKey`). **Note:** a proxy URL *can* embed credentials (`http://user:pass@host`); it is stored and shown in plaintext, same as a secret in a `base_url` query string — by design, consistent with the existing wire contract. Raw `api_key` still never crosses the wire.
- **Web** — `PublicConfig.providers` gains `proxy?`; `ProvidersPage` adds a Proxy input to both the provider detail view (edit + Save → `onSaveField(name, 'proxy', …)` → PATCH `providers.<name>.proxy`) and the add-provider form (`AddProviderInput.proxy` → `ConfigScreen` writes `providers.<name>.proxy` on create). Placeholder documents "blank = direct".
- Verified: full `typecheck && build && test` green. +1 web test (ProvidersPage: proxy shown + Save emits the `providers.<name>.proxy` key, trimmed), +1 service assertion (PATCH `providers.xai.proxy` surfaces in the sanitized view). Backend `setValue`/direct-vs-proxied already covered by v0.40.0's `ProviderProxy.test.ts`.

## 2026-07-10 — v0.40.0 — xAI Grok provider (SuperGrok OAuth) + per-provider proxy

Adds `xai` as an OAuth provider so a SuperGrok / X Premium+ subscription drives Grok models with no separate API key — the same subscription-OAuth pattern as `chatgpt`, but simpler because `api.x.ai/v1` is a plain OpenAI-compatible surface: the OAuth access token is used as a normal `Bearer` credential with no special backend or account header.

- **Auth** (`packages/cli/src/auth/XaiAuth.ts`) — authorization-code + PKCE (S256) against `auth.x.ai` (authorize `…/oauth2/authorize`, token `…/oauth2/token`). Uses xAI's public desktop Grok-CLI client id `b1a00492-073a-47ea-816f-4c329264a828` (not a secret; corroborated against two OSS impls and the user's own `~/.grok/auth.json`), scope `openid profile email offline_access grok-cli:access api:access`, `plan=generic`, `referrer=hermes-agent`. Proxy-aware fetch (`proxyDispatcher`) so it works behind an HTTPS proxy. **Dual completion:** a loopback listener on `127.0.0.1:56121/callback` *and* a paste prompt — xAI usually shows a "copy this code" page instead of redirecting, so `extractPastedCode` accepts a bare code, a `code=…&state=…` querystring, or the full redirect URL (state-checked when present); pressing Enter falls back to waiting for the redirect. Token-exchange/refresh errors now surface undici's `.cause` (e.g. `ECONNREFUSED`) instead of a bare "fetch failed".
- **Refresh** (`packages/core/src/config/XaiTokenRefresh.ts`) — `refresh_token` grant; `MarifoldRuntime.refreshProviderCredentialsIfNeeded` now handles `xai` alongside `github_copilot`/`chatgpt`, persisting `apiKey`=access, `oauthToken`=refresh, `apiKeyExpiresAt`.
- **Registry** — `xai` entry: `kind: 'oauth'`, `type: 'openai-compatible'`, base `https://api.x.ai/v1`, `apiKeyEnv: 'XAI_API_KEY'` (env override still honored), known-model fallback trimmed to what a SuperGrok subscription actually exposes: `grok-4.5`, `grok-composer-2.5-fast` (matches Grok Build CLI's `~/.grok/models_cache.json`; live `/v1/models` is authoritative, the picker also takes a custom id). CLI `model add xai` goes straight to browser OAuth (per the "OAuth only" choice; a raw key is still honored via `XAI_API_KEY`, not prompted for storage).
- **Per-provider proxy** (`ConfigSchema`/`Loader`/`Manager`/`ProviderFactory` + **priest 2.7.0**) — uniform optional `[providers.<name>].proxy = "http://127.0.0.1:7890"` on every provider: set → proxied, unset → direct (falls back to `HTTPS_PROXY` env only when unset). Local (`ollama`) and Chinese providers stay direct; `xai` behind the GFW sets its own. Threaded into the chat fetch **and** token refresh. **Root cause it fixes:** marifold's own `fetchResponse` (ChatGPT/Copilot *Responses* path) already applied a dispatcher — which is why ChatGPT worked behind the proxy — but standard **chat-completions** (xai, openai, deepseek, …) delegates to priest's `OpenAICompatProvider`, whose `fetch()` had **no dispatcher hook**, so it could never be proxied (the TUI's `fetch failed`). Added a `dispatcher?` option to priest's `OpenAICompatProvider` (applied to both `complete()` and `streamEvents()`); marifold passes `proxyDispatcher(provider.proxy)`. This fixes proxying for *all* openai-compatible providers, not just xai. Settable via `config set providers.xai.proxy <url>`; +4 core tests (parse/direct-default/save/set-clear). **Verified live:** marifold's `xai` provider streams a real `grok-4.5` reply through the proxy. Depends on **`@priest-ai/core@2.7.0`** (published to npm; adds the `dispatcher` option). `minimumReleaseAgeExclude` bumped to 2.7.0.
- Verified: **+4 core tests** (XaiTokenRefresh: grant shape, token rotation, missing-token + HTTP-error paths) and **+6 CLI tests** (XaiAuth: `extractPastedCode` bare/URL/querystring/state-mismatch/whitespace, authorize-URL builder); full `typecheck && build && test` green across all packages. **Live status:** first sign-in attempt failed — the loopback redirect never fired (browser stayed on xAI's "copy the code" page) and the token POST hit a transport error; the paste path + `.cause` surfacing above are the fix, pending the user's re-run of `marifold model add xai` and a real `grok-4.5` turn (both need a TTY).
- **Verified live end-to-end:** with the user's stored OAuth token, a proxied `grok-4.5` POST to `https://api.x.ai/v1/chat/completions` returned **HTTP 200** with a real completion — the endpoint choice and OAuth-token auth are confirmed. (Grok Build CLI's own `cli-chat-proxy.grok.com` surface returns HTTP 426 "CLI version outdated" — it's gated to the Grok binary, not for third-party clients, so `api.x.ai/v1` is the correct surface.) The earlier TUI `fetch failed` was purely the missing proxy env, now fixed by the config `proxy` key.
- **Open:** confirm in the TUI after setting `proxy` in config (or exporting `HTTPS_PROXY`); no version bump / release cut yet. Device-code flow (`…/oauth2/device/code`) exists as a future headless fallback. Note: `MarifoldOpenAICompatProvider` applies the proxy dispatcher unconditionally, so a configured `proxy` will also route localhost `openai-compatible` providers (llama.cpp/LM Studio/Rapid-MLX) through it — pre-existing with an env proxy, no `NO_PROXY` honored; `ollama` is a separate provider class and unaffected.

## 2026-07-06 — v0.39.1 — Markdown blockquotes/rules + larger nav logo

First fixes from the user's browser pass on v0.38–0.39: the hand-rolled markdown parser merged `> …` lines into paragraphs as literal text (visible in translation replies) — blockquotes now parse as real blocks (inside parsed as its own document, marigold-edged rendering) and `---`/`***`/`___` become horizontal rules; the nav logo goes 20 → 28px. 388 tests (web 84, +2 parser). **Known gap:** tables still render as plain text rows — add if models emit them often.

## 2026-07-06 — v0.39.0 — Profiles & system config: avatars, creation, Config redesign, providers/models

Second half of the user-review round (items 2, 4, 5, 6): profiles become first-class identities and the Config screen becomes the system control surface.

- **Avatars** — stored as `avatar.(png|jpg|webp)` in the profile's own dir (the user's suggested location; ≤1 MB, replaces across extensions, works for the built-in default by scaffolding its dir). `ProfileSummary.avatar` presence flag via shared `findProfileAvatar`; runtime get/set/delete. Service: `GET /v1/profiles/:name/avatar` (raw bytes, ETag/If-None-Match 304, no-cache), `PUT` (base64 `{data, mediaType}`), `DELETE`. Web `Avatar` component fetches with auth → blob URL (`<img src>` can't carry a bearer token), falls back to the marigold initial; wired through the Agent sidebar, thread header, Config columns, and the profile page (change/remove control).
- **Profile creation** — `runtime.initProfile` + `POST /v1/profiles` (201; duplicate/bad names 400). Web: `+` in the Agent sidebar and Config profiles column opens a light `CreateProfileSheet` (name with live validation, avatar picker, mode, model); create → patch → avatar upload → land in the new profile (Agent) or its Config page. Docs/permissions stay on the existing editor — one editing surface.
- **Config redesign (3-column, Mail-style)** — sections (Profiles/Providers/Models/Service) → items column (profiles with avatars, providers with reachability dots) → detail. The original routes used `#/config/<section>[/<item>]`; current releases migrate those bookmarks to clean `/config/…` paths. Replaces the v0.36 profiles-as-sidebar list that would sprawl with many profiles.
- **Providers & models management** — runtime wraps `ProviderInspector` (status, live model listing) and `ConfigManager` model writes; service adds `GET /v1/providers/status`, `GET /v1/providers/:name/models`, `POST`/`DELETE /v1/models`, `PUT /v1/models/default`. Providers page edits `base_url`/`api_key_env`/`type` via the existing `PATCH /v1/config` dotted keys (which create unknown provider sections) + an add-provider form; Models page manages saved options/default with live per-provider suggestions; Service page edits `web_dir`/`cors_origins`/`token_env` against the sanitized view. **Security stance:** raw `api_key` values are not accepted or shown over the wire — env-var names only; keys stay CLI/file-only.
- Verified: **388 tests** — core 223 (+1 avatar lifecycle), service 36 (+4: create/avatar/model-management/status-sanitization), tui 43, cli 4, web 82 (+3: route round-trips incl. legacy redirect, ModelsPage, ServicePage). **Live** (built CLI on the real config): `POST /v1/profiles` scaffolded, avatar PUT→GET round-tripped (image/png, 70 B, ETag), provider status probed the real providers (ollama reachable, 6 models; key-holding providers sanitized to booleans), live ollama model list returned.
- **Open:** browser pass on the new Config columns/avatars pending user verification; profile rename/delete UI, raw-key editing (CLI-only by design), and `/v1/events` push remain backlog; provider add relies on dotted-key section creation (verified in ConfigManager).

## 2026-07-06 — v0.38.0 — Agent experience polish + attachments

First of two user-review milestones on the Web UI MVP (items 1, 3, 7, 8, 9 of the review; v0.39.0 takes profiles/avatars/Config redesign/providers-models).

- **Marigold logo** — the project's petal mark (from the user's SVG) inlined as a `currentColor` React component in the top nav (per-instance `useId` so multiple logos don't collide on the shared `<defs>` id) and as the tab favicon.
- **Inline run meta (ChatGPT-style)** — run usage/duration moved out of the card: it renders as a muted `2s · 512 tokens · $0.01` suffix at the end of the run's response prose. A completed run with no tool rows/plan/steering/denials/errors gets **no card at all**; while such a run is still silent, an inline shimmer `Thinking…` line (with Cancel) stands in and comes down when prose streams. Failed/cancelled/blocked keep the card — status must stay visible. New `hasRunActivity`/`isTrivialRun` in `state/thread.ts`.
- **White content pane** — surfaces split into chrome vs content: nav + sidebars share `--canvas` (the warm gray), the thread/config/apps panes sit on new `--content` (white in light, one step lighter than chrome in dark). Run cards moved to the full-strength separator so white-on-white reads.
- **Thread header + collapsible sidebars** — `ThreadHeader` above the conversation: sidebar toggle (persisted `marifold.sidebars`), session title, `profile · mode`. Core: `SessionSummary.preview` — first user turn, whitespace-collapsed, ~80 chars, via a correlated subquery in `SessionResolver.list()` — now titles the session list and header (timestamp fallback).
- **Attachments** — `RunStartInput.images` → RunRegistry → the runner's existing first-turn attach (chat/ask already had the wire field); the images validator moved to shared `Validation.ts`; fastify `bodyLimit` raised to 25 MiB for base64 payloads. Web: `+` picker, drag-drop onto the thread pane (overlay), paste-from-clipboard; images (PNG/JPEG/WebP/GIF, ≤4, ≤5 MB total) ride `images[]` on both chat and runs; text files (≤256 KB, MIME or extension) inline into the prompt as filename-headed fenced blocks (fence stretched past inner backticks); rejects surface as warn notices; user bubbles render thumbnails + file chips. Pure rules in `lib/attachments.ts`.
- Verified: **380 tests** — core 222 (+1 preview), service 32 (+1 image→provider e2e), tui 43, cli 4, web 79 (+18: trivial-run matrix, thinking-line up/down, header, attachment classification table, fence stretching, caps). **Live** (built CLI on the user's real config, port 32155): static shell serves the new build; real sessions list with truncated previews; `POST /v1/runs` with a base64 1×1 red PNG → ollama `gemma4:e4b` answered "Red" (708 tokens). Field notes: the `-mlx` model variants ignore images (server-side, no vision path), and the `github_copilot/gpt-5.4-mini` default rejected the request entirely (`model_not_supported`) — attachment UX depends on picking a vision-capable model.
- **Open:** light-theme knock-ons and the new header/collapse need the user's browser pass; sending attachments with an empty message is disallowed (text required); binary non-text files rejected by design. v0.39.0 = profiles & system config (avatars, create-profile sheet, 3-column Config, providers/models management).

## 2026-07-05 — v0.37.0 — Config editing: write routes, editable profile UI, CLI `config get`

The Web UI's Config screen becomes a real editor (the v0.36.0 "read-only this milestone" promise), and config writes get one uniform surface across CLI and HTTP.

- **Core write surface:** `ConfigManager.setValue` routes `service.*` (`token_env`/`token`/`web_dir`/`cors_origins` comma-separated; `""` clears) and gains `getValue` mirroring the set keys (arrays comma-joined, unset = undefined, unknown throws). `ProfileManager`: `writeProfileFile` (PROFILE/RULES/CUSTOM.md — previously uneditable after init), `removeTrustedFolder`, `setAgentApproval(…, undefined)` clears an override (inherit again), `setMemories`/`setThink`/`setSessionContextTurns`; flat-line upserts share one `upsertFlatLine`. `MemoryStore.forgetById`/`deleteById` — **exact-by-id** mutations (query `forget`/`delete` fuzzy-match text, wrong semantic for a per-row UI action). All exposed on `MarifoldRuntime`.
- **Service:** `PATCH /v1/profiles/:name` (partial settings; `null` = clear override, absent = untouched), `PUT /v1/profiles/:name/files/:file`, trusted-folder `POST`/`DELETE` (folder in the body — slashes), `DELETE /v1/profiles/:name/memories/:id?mode=forget|delete`, and `PATCH /v1/config { key, value }` with exact CLI `config set` parity. Sanitized `[service]` view on `GET /v1/config` (`webDir?`, `tokenEnv?`, `corsOrigins`, `hasToken` — never the token). Routes guard unknown profiles up front so MemoryStore can't scaffold phantoms.
- **Security hardening (from the v0.36 review):** `/v1` auth gating now judges the **normalized decoded pathname** (fail-closed on undecodable/`\0`/backslash/non-`/` starts; explicit leading-slash collapse — `new URL` was rejected because `//v1/x` parses protocol-relative and hides the prefix). Locked with a regression test: `//v1/config`, `/v1?x=1`, `/v1/../v1/config`, `/%761/config` all 401 under a token.
- **CLI:** net-new `config get <key>`; `config set` help documents the `service.*` keys.
- **Web:** `ProfileSettingsPage` is editable — real `SegmentedControl` permissions (per-kind inherited-vs-overridden tag + inherit-reset patching `null`; writes always target the profile override, never the resolved value), mode control, model select from saved options (+"Default" clears), memories/thinking toggles, trusted-folder add/remove (global ones shown as inherited, not removable), PROFILE/RULES/CUSTOM textarea editors with Save/Revert, memory rows with Forget (immediate) / Delete (confirm). Save-then-refresh: each route returns the fresh `ProfileDetail`, which replaces local state — no optimistic writes. Client transport gains `PUT`.
- Verified: **355 tests** — core 221 (+7), service 31 (+5 route/auth-hardening/canary), tui 43, cli 4, web 56 (+9: editor interactions, writer wire shapes, real-Fastify PATCH e2e). Builds clean incl. `apps/web`. CLI round-trip verified live (`config set/get service.*` on a temp config; unknown key exits 1).
- **Open:** v0.38.0 = the SYSTEM screens (models & providers, default permissions, appearance) on top of `PATCH /v1/config`; the per-profile `think` control is a 2-state toggle in the UI (the API supports `null` inherit); memory content authoring stays model-driven by design. Live browser pass pending user verification.

## 2026-07-05 — v0.36.0 — Web UI (apps/web): Agent screen, read-only Config, static hosting

The browser client, built to the committed Claude Design concept (`docs/design/`) as a second renderer of the same contracts the TUI renders. Vite 6 + React 19, zero UI-framework deps, marigold tokens once via CSS `light-dark()` (auto/light/dark).

- **Structure (the point):** one-way dependency flow documented in `apps/web/README.md` — `api/` (fetch wrapper, pure SSE parser, resumable `followRun` with `Last-Event-ID` reconnect + seq dedup) → `state/` (pure `threadReducer` + `RunFollowers`) → `components/` → `screens/`; `lib/` pure utils (hand-rolled markdown token tree — no innerHTML; dependency-free routing, now clean-path based; permission merge mirroring core). One file (`api/types.ts`) imports the wire contract **type-only** from `@marifold/core`; `verbatimModuleSyntax` makes a runtime-import slip a compile error.
- **Agent screen:** profiles → sessions → one thread carrying both reply kinds — streamed chat turns and **run cards** (plan checklist, tool rows folding by `callId`, `Guidance applied` pills, elapsed clock + Cancel, collapsed `✓ Ran 1m 24s · N tool actions` footer with usage). **ApprovalSheet** = Deny / Always allow kind or Trust this folder / Allow once ⌘⏎. Input bar steers instead of sending while a run is active; Think pill + per-message model chip. Send routing follows the profile's mode (the Telegram bridge rule). Catch-up: session replay + attach running runs + "While you were away" banner; 10s visibility-gated polling spots runs started from the TUI/Telegram.
- **Config (read-only this milestone)** — identity, model, the memory inspector, all five permission kinds resolved defaults<global<profile (global `[agent]` now exposed in `/v1/config`), trusted folders, PROFILE/RULES/CUSTOM viewers. **Apps** = honest placeholder (no App runtime yet).
- **Service hosting:** `[service].web_dir` / `--web-dir` → hand-rolled static routes (traversal-guarded, immutable-cached `/assets`, SPA fallback; `/v1` + `/health` JSON untouched). Two Security changes it forced: an Origin equal to the request's own loopback Host passes (fetch sends Origin on all non-GET — the served app would otherwise 403 against its own service), and **bearer auth narrowed to `/v1/*`** so the shell stays reachable.
- Verified: **333 tests** — core 214, service 25 (+6 static/traversal/same-origin/auth-scope), tui 43, cli 4, **web 47** (SSE framing, follower reconnect semantics, the full reducer suite, component smoke via jsdom, and an integration suite driving the real ApiClient against a real service). **Live** (built CLI + `--web-dir`, ollama gemma4:e4b-mlx): shell/assets/SPA-fallback/traversal/`config.agent` via curl; a run driven with same-origin Origin headers exactly as the browser does — parked at `approval_request`, steered (event emitted + note delivered; the small model didn't honor the hint in its output — model compliance, not mechanism), approved → file written, 9 events in order, session persisted (2 clean turns for thread replay).
- **Open:** Config **editing** (write routes, incl. `config set/get` support for `[service]` keys) is v0.37.0; a UI polish round is queued (user-confirmed working in a real browser 2026-07-05, served via `[service].web_dir` — this entry is the accepted MVP); attachments on `POST /v1/runs`, mobile nav polish, session title/preview field, a `/v1/events` push channel to replace run polling — backlog. Vite pinned to ^6 while `engines >=18` stands.

## 2026-07-04 — v0.35.0 — Agent-run service routes + auth/CORS (Web UI prep)

The service milestone before the Web UI: app clients can now drive agent runs over HTTP, and the wire contract is written down (`docs/service-api.md`) as the handoff artifact for the UI design track. No priest change needed.

- **`RunRegistry` (core, `src/runs`)** — the live layer TaskStore can't hold: `start()` launches a detached AgentRunner pump and returns a `RunRecord` immediately; sequenced event buffer with `afterSeq` replay (bounded, finished runs evicted after 5min); approval handler mirrors the Telegram bridge (once / always→profile / trust-folder→profile / deny, per-run grant layer, 5-min timeout auto-deny); **cancel resolves a pending approval instantly** (else the loop would sit blocked at the handler await until timeout); `steer()` feeds the runner's drain. `runtime.createRunRegistry()` binds a narrow runtime slice, so the registry unit-tests against a scripted engine (14 tests).
- **`/v1/runs` routes (service)** — POST start → 201; GET list/get (records carry `pendingApprovals` for polling clients); `GET :id/events` = resumable SSE of the **AgentEvent union verbatim** (`id:` seq, `retry:` hint, 15s heartbeats, `Last-Event-ID`/`?after` replay); POST `approvals/:requestId` (`once|always|trust|deny`), `steer` (202), `cancel` (202, idempotent). Chat stream stays one-shot by design (reconnect would re-run the prompt) but gains the heartbeat.
- **Auth + origin policy** — one `onRequest` hook (`Security.ts`): exact-match CORS allowlist (`[service].cors_origins`, preflight short-circuit, **403 on any other Origin** — hostile pages can't poke the loopback service), loopback `Host` check (DNS rebinding), optional bearer token (`[service].token_env`/`token`, `--token`/`--token-env`; timing-safe compare; `/health` exempt; `?access_token=` only on the runs SSE path for native EventSource). Tokenless bare loopback stays the default. New error codes UNAUTHORIZED/ORIGIN_FORBIDDEN/RUN_NOT_FOUND/APPROVAL_NOT_FOUND/RUN_LIMIT_EXCEEDED mapped 401/403/404/404/429; fixed `AGENT_RUN_INVALID` 500→400.
- **`steering` AgentEvent** — the runner now emits drained `/btw`/steer guidance on the stream so every attached client sees it land (TUI renders an info notice). The one AgentEvent union change, agreed as contract-worthy.
- **Fix: chat-stream disconnect now aborts the model call** — `streamChat` only stopped writing; an `AbortController` on raw `close` → `MarifoldRunRequest.signal` proves the whole chain in a socket-destroy test (captured provider signal aborts).
- Service internals split: `Sse.ts` (shared framing/heartbeat), `Validation.ts` (shared body validators), `RunRoutes.ts`, `Security.ts`.
- Verified: core 214 (+14 registry, +steering/config), service 19 (+5 security via inject, +9 runs over a **real listen** with a passthrough fetch stub), tui 43, cli 4 — all pass; 4 packages typecheck + build clean. **Live E2E** (built CLI, temp config, ollama gemma4:e4b-mlx, `--token`): 401/Bearer/preflight/403-origin via curl; a run parked at `approval_request`, steered while pending, approved via POST → haiku written, `steering`+`text`+`done completed` on the stream (1.4K tokens usage reported), `Last-Event-ID: 3` replayed exactly 6/9 frames; second run cancelled mid-model-call → `cancelled`. Also fixed the CLI `.version` stuck at 0.28.0.
- **Open:** service-level "always"-persists-to-disk assertion is covered by the core spy test, not an HTTP test (ProfileManager write path already unit-tested); images on `POST /v1/runs` deferred (chat/ask has them); memory/schedule **write** routes deferred until the Web UI needs them; `apps/web` itself is the next milestone — build against `docs/service-api.md`.

## 2026-07-01 — v0.34.0 — Telegram: approvals, file inbox/outbox, /think, ChatGPT reasoning

The in-service Telegram bot became genuinely useful — verified live (approvals tapped, a poem `.md` delivered as an attachment, a photo saved to the inbox).

- **Approval over Telegram** — agent tool approvals prompt with inline buttons (`Allow once` / `Trust folder` | `Always allow <kind>` / `Deny`) and the run waits for the tap; "always"/"trust" persist to the profile + session, no tap in 5min auto-denies. `respond()` gained an optional `approvalHandler`; the bridge loop dispatches turns **detached** so a mid-run approval's `callback_query` (arriving on a later `getUpdates`) can't deadlock the poller (one turn at a time via a busy flag).
- **File inbox/outbox** — photos/documents download to `~/.marifold/profiles/<profile>/inbox/` (with the path injected into the next turn); agent runs use `outbox/` as `cwd` (trusted → silent writes), and files left there are delivered via `sendDocument`/`sendPhoto` and moved to `outbox/sent/`. Multipart upload works through the proxy. Core: per-run `AgentRunOptions.trustedFolders` + `respond()` `cwd`/`trustedFolders`/`instructions`.
- **Fixes from live testing** — `WriteFileTool` checks trusted folders **before** the workspace so a trusted cwd (the outbox) is auto-approved not merely non-escalated (outbox writes stopped prompting); the agent is told its files are auto-delivered (stops "I can't send files" then delivering one); friendlier "run didn't complete" reply; file downloads retry 3×.
- **`/think` on|off** — per-chat, threaded through `respond()` to chat (`runtime.stream`) and agent (`AgentRunOptions.think`); warns when the provider won't honor it.
- **ChatGPT reasoning** — `chatgpt` is now think-capable; the Codex-backend request translates `think=true` → `reasoning: {effort:'high'}` (raw `think` stripped), **only when on** so the default request is byte-identical to the working flow.
- Verified: core 199 (+ approval routing, inbox/outbox integration, trusted-as-cwd, `/think`, reasoning translation), tui 43, service 4, cli 4 — all pass; 4 packages typecheck + build clean. Live over Telegram end-to-end.
- **Open:** vision (the bot saves images but can't *see* their contents — needs multimodal image input); one live check that the Codex backend accepts the `reasoning` param on the chosen model.

## 2026-06-30 — v0.33.0 — Telegram bridge (live, in-service) + edit-aware channel setup

The bridge deferred in v0.31.0 is live: a Telegram bot running **inside `marifold service`** replies through a profile's model — verified end-to-end (message from a phone → reply) behind a proxy.

- **`TelegramBridge`** (`core/channels/TelegramBridge.ts`) — long-poll `getUpdates` → allowlist check → `respond()` under the configured profile (unattended; the profile's permissions govern) → `sendMessage`. Per-chat mode with `/agent` `/chat` `/new` `/help`, 4096-char chunking, **proxy-aware** (Telegram is blocked in CN), and it never crashes the service (poll errors → log + backoff).
- **`runtime.createTelegramBridge()`** mirrors `createScheduler`; `createMarifoldService` starts/stops it alongside the scheduler so **one `marifold service` powers HTTP + schedules + Telegram** (and the future Web/desktop/mobile clients). `marifold service` prints `Telegram bridge active (profile X)`.
- **`channel telegram setup` is now edit-aware:** re-run to change a single field — profile preselects the current one (else `default`, the init-created profile); token/allowlist/mode keep on an empty Enter. Fixed a stdin-handoff bug where the eagerly-created readline interface swallowed the input meant for the allowlist prompt (it returned EOF immediately).
- Verified: core **193** (+7 bridge routing tests: allowlist filter, command routing, `/agent` switch, denied-tool note, chunking), service 4, cli 4 — all pass; 4 packages typecheck + build clean. Live over Telegram: `/start`, a chat reply, and a model Q&A.
- **Next:** per-chat concurrency hardening (`busy_timeout`) only if it grows; Slack/other channels reuse the same `respond()` seam.

## 2026-06-30 — v0.32.0 — ChatGPT subscription provider (Codex backend) + proxy plumbing

ChatGPT sign-in now works on a **ChatGPT plan** (no platform org, no API key) by talking to the **Codex backend** the way the Codex CLI does — verified live end-to-end behind a proxy (OAuth → streamed reply with token usage).

- **Subscription mode, not api-key exchange.** A ChatGPT-plan id_token carries no `organization_id`, so the old `requested_token=openai-api-key` exchange always 401'd (`Invalid ID token: missing organization_id`). Replaced it: the OAuth **access token** is the credential, and `chatgpt_account_id` is decoded from the id_token (`core/util/idToken.ts`) and sent as the `chatgpt-account-id` header.
- **Transport.** `chatgpt` provider → `https://chatgpt.com/backend-api/codex` (was `api.openai.com`), always the Responses API, with headers `chatgpt-account-id`, `originator: codex_cli_rs`, `OpenAI-Beta: responses=experimental`, `session_id`, plus `store:false`. The backend is **SSE-only** (`"Stream must be set to true"`), so the non-streaming `complete()` path drives the stream and accumulates. `knownModels` → `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.4-mini` (unversioned `gpt-5`/`gpt-5-codex` are sunsetting); model listing skips the nonexistent `/models` probe.
- **Storage + refresh.** New `account_id` provider field (schema/loader/manager/runtime); refresh returns the access token directly (no exchange) and re-derives `accountId`.
- **Proxy plumbing (prerequisite from China).** Node's `fetch` ignores `HTTPS_PROXY`; wired undici `ProxyAgent` into the ChatGPT OAuth/refresh, Copilot/ChatGPT model calls, and search backends (`core/util/proxy.ts`). Fixed a `??`→`||` empty-string bug (some tools set `HTTPS_PROXY=""` + lowercase `https_proxy`). Added `undici` as a core dep.
- **Sign-in robustness.** Force-close the local OAuth callback's keep-alive sockets (`server.closeAllConnections()`) so sign-in no longer hangs after the token exchange; token-exchange timeout 20s→60s for slow proxies.
- Verified: core 186 (+ id_token account-id extraction, Codex-backend URL/headers/`store:false`/`stream:true`, proxy empty-string regression), tui 43, cli 4 — all pass; 4 packages typecheck + build clean. Live: ChatGPT Plus reply through the Codex backend with token usage.
- **Caveat:** unofficial, gray-area path (same fragility Codex/OpenClaw carry) — OpenAI can change it anytime, and Codex-account model names churn.

## 2026-06-30 — v0.31.0 — Telegram channel: pre-bridge foundation (prep only)

**Prep only — there is no running Telegram bridge yet.** This builds everything that *isn't* Telegram-network-specific so the actual bot (a long-poll loop) becomes a thin shim. Decisions for v1: **unattended** approvals (bot honors the profile's permissions + trusted folders; `ask`→deny — no approval-over-Telegram) and **single-user** (defer concurrency hardening).

- **`respond()`** (`packages/core/src/channels/respond.ts`) — the reusable, channel-agnostic "run one turn → reply" helper any bridge calls. `chat` accumulates `runtime.stream` chunks; `agent` runs `createAgentRunner(profile)` with **no `approvalHandler`** (unattended). Returns `{ text, ok, denied }`: `denied` names tools it couldn't run; **`ok` flags a non-completed agent run** so a channel never sends a silent/empty reply on a failed run.
- **`[channel.telegram]` config surface** — `ConfigSchema` (`enabled`/`botTokenEnv`/`botToken`/`allowlist`/`profile`/`defaultMode`; token follows the provider secret pattern, `botTokenEnv` preferred), parsed in `ConfigLoader`, serialized in `ConfigManager`.
- **`marifold channel telegram setup`** — interactive: bot token (SecretPrompt) + allowlist + profile picker + default mode → writes the config.
- **`marifold doctor`** — a **Channel (telegram)** readiness section: token resolvable, allowlist non-empty, linked profile exists → ✓ ready / ✗ not ready.
- Verified: core 178 (+ `respond` chat/agent/denied/failed-run, `[channel.telegram]` parse + bad-`default_mode` reject), tui 43, service 4, cli 4 — all pass; 4 packages typecheck + build clean. Doctor channel section exercised live (token unset→not-ready, set→ready). No behavior change to existing flows.
- **Next:** the bridge itself — `marifold channel telegram` (long-poll `getUpdates` → allowlist → `respond()` → `sendMessage`, per-chat `/chat`·`/agent`, `sessionId = "tg-<chat_id>"`). Deferred: `busy_timeout` on priest's session-write path (only if concurrency grows), approval-over-Telegram. Plus your manual @BotFather bot + a dedicated profile.

## 2026-06-29 — v0.30.0 — Per-profile permissions + trusted folders

Groundwork for the upcoming Telegram/messaging channel (a remote bot honours *its profile's* permissions). Two ideas, one prompt — no per-folder permission matrix.

- **Per-profile `[agent]`.** `profile.toml` can override the whole `[agent]` table (approval kinds, `trusted_folders`, `max_iterations`, `tool_mode`), merged `default < global < profile`. So a `computer_helper` profile can `agent.approval.shell = "allow"` while a `writing_helper` (weak model) stays restricted. A shared `parsePartialAgentConfig` validates both the global `[agent]` and the profile form; `resolveAgentConfigForProfile` + `createAgentRunner(profile)` thread the run's profile through (chat tools + scheduled runs included).
- **Trusted folders.** `agent.trusted_folders` is a flat allowlist of folders (outside the workspace) where file writes are allowed without prompting. `WriteFileTool.assessRisk` returns non-escalated + `trusted` there, and `AgentRunner` auto-approves it **before** the unattended-deny — so a scheduled profile can write outside the project (e.g. a daily blog to `~/my_docs/blog`). `ProfileManager.addTrustedFolder` persists (array upsert) and **refuses sensitive roots** (`~`, `/`, `~/.ssh`, `~/.marifold`). New `/trust-folder <path>` command.
- **Simplified approval prompt: Allow once / Trust / Deny.** "Trust" persists to the **active profile** — allow-always for the kind, or (for an out-of-workspace write) the folder into `trusted_folders`. **Enter = allow once** (safe default; never persists/trusts on a stray key). An in-session layer (`sessionGrants` + `sessionTrustedFolders`) makes the *current* run stop asking, since the run's baked config can't see the new on-disk grant. `/permissions` now shows the per-profile resolved approval + trusted folders.
- **Docs:** README `[agent]` section + `profile.toml` properties table updated (per-profile override, `trusted_folders`, the new prompt).
- Verified: core 173 (+ per-profile parse/merge incl. trusted-folder union, `assessRisk` trusted, `addTrustedFolder` round-trip + sensitive-root refusal, and the **unattended trusted-write executes end-to-end** — the blog case), tui 43 (modal keys + contextual trust label), service 4, cli 4 — all pass; 4 packages typecheck + build clean.
- **Residual:** trust granularity is the immediate parent dir (`/trust-folder <broader>` to widen); `isInsideAny` uses `path.relative` (not realpath), matching the pre-existing workspace check; the within-run "Trust → stop asking" *feel* and real keypress→trust path are TTY-staged (their inputs are unit-tested).

## 2026-06-28 — v0.29.0 — Session-DB doctor + small UX (/retry, picker cap, per-profile think)

- **`marifold doctor` (new CLI command).** Reports the active provider/model config and runs a **read-only session-DB integrity check** (`SessionResolver.checkIntegrity` → `runtime.checkSessionDb`). It lives on the CLI rather than the TUI `/doctor` on purpose: when the session DB is corrupt the TUI can't even start (`listSessions` throws at launch), so the diagnostic must be reachable from a command that never opens the store eagerly. Never throws; reports OK (with session/turn counts), CORRUPT (with the integrity error), or "none yet".
- **Session-DB hardening (marifold connections).** `SessionResolver` now opens through a helper applying `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5000`. **Honest scope:** priest's `SQLiteSessionStore` *already* sets WAL on the main write path, so WAL here is consistency, not the corruption fix — the real adds are `busy_timeout` (marifold ops wait under lock contention instead of erroring) and `synchronous=NORMAL`. The corruption incident that prompted this was already a WAL DB, so the likely cause was concurrent access / I/O, not missing journaling. Highest-leverage remaining hardening is `busy_timeout` on **priest's** write connection (deferred — priest change). Guided `marifold session repair` (backup-first recovery) is the planned next step.
- **`/retry` (alias `/regenerate`).** Re-runs the last plain-text message through the current profile/model/mode — one-keystroke model A/B (switch with `/model`, then `/retry`). Captures the prompt in a ref inside `startTextRun`, not by scanning the transcript, so it can never replay a `/command` or `$skill` echo. Appends a new turn.
- **`SelectList` viewport cap.** Windowed list capped at 12 rows so a long list always windows (with the `↑/↓` counter) and stays on-screen even on very tall terminals — same class of overflow the CLI model picker had. Applies to all overlays.
- **Per-profile `think` default.** `profile.toml` gains `think`; precedence `request > profile > default.think` (off). Unset profiles stay off — no edits to existing profiles. The generated `profile.toml` template now lists **every** option (commented, with defaults), shared by `profile create` and `marifold init`.
- Verified: core 165 (+SessionResolver integrity/WAL, profile `think` parse + precedence), tui 43 (+/retry), service 4, cli 4 — all pass; 4 packages typecheck + build clean. `marifold doctor` exercised live (healthy DB, missing DB, garbage file). TTY-only paths (real `/retry` feel, picker on a tall terminal) staged.

## 2026-06-27 — v0.28.2 — Model-picker viewport, cached-on-server label, priest 2.6.1

- **`marifold model add` picker no longer overflows.** `selectTerminalOption` (`packages/cli`) rendered every option as its own line with no viewport, so a 50+ model list overflowed the terminal and the cursor-up redraw couldn't reach scrolled-off rows — the list pinned to the bottom and the selection cursor scrolled above the top edge. Now it renders a **windowed viewport** centered on the selection with a constant block height (`<= terminal rows`) and a `↑ N more / ↓ M more` hint, plus a **width clip** so long model names can't wrap and re-desync the cursor-up math. New `TerminalSelect` tests (height cap, selection-stays-in-window, short-list full render, width clip). The in-app TUI `SelectList` was left as-is (its windowing only disengages when the full list also fits).
- **Run-summary cached tokens now read `cached on server`.** `cachedInputTokens` is the provider's server-side prompt cache (e.g. DashScope), not the local session store; the bare `cached` was ambiguous.
- **`@priest-ai/core` → npm `^2.6.1`.** Dropped the temporary local link now that 2.6.1 is published. 2.6.1 makes OpenAI-compatible **streaming** requests opt into token usage (`stream_options.include_usage`), so models like `deepseek-v4-flash` on bailian now report cost/context instead of `ctx –/16K`. `minimumReleaseAgeExclude` bumped to 2.6.1.
- Verified: resolves from npm (`@priest-ai+core@2.6.1`, published dist carries the fix); typecheck + build clean; core 159, tui 42, cli 4 pass. CLI picker's real-TTY cursor path covered at the unit level only.

## 2026-06-27 — v0.28.1 — Chat-mode cancel actually aborts the in-flight request

- **ESC/`/stop` in chat mode didn't stop generation.** `runChat` never created an `AbortController`, so `MarifoldRuntime.stream()` got no signal and the provider's streaming `fetch` ran to completion; `abortRef` was only set in agent mode, so `stop()`'s `abort()` was a no-op in chat; the lone `cancelChatRef` break only fired at the *next* chunk boundary, after the await. Net effect: "Cancelling…" showed but the model kept running "for a while" — exactly the reported symptom.
- **Fix:** `MarifoldRunRequest` gains `signal?: AbortSignal`, forwarded to `engine.streamEvents(..., { signal })`; the OpenAI-compat/Ollama providers already wire that signal into the streaming body read, so an abort tears down the connection immediately. `runChat` now owns an `AbortController` (sets/clears `abortRef`, suppresses the spurious error toast on abort). Unified both modes on `controller.signal.aborted` and removed the redundant `cancelChatRef`.
- **UX:** on cancel the lingering "Cancelling…" is replaced by a terminal **"Cancelled."** notice (chat *and* agent), so a cancel is visibly resolved.
- Verified: core 159 (+1: runtime forwards the run signal to the provider so a cancel aborts the in-flight stream), tui 42 — all pass; 4 packages typecheck + build clean. TTY keypath not runnable here; covered at the runtime level.

## 2026-06-25 — v0.28.0 — Per-profile `session_context_turns` (recent-turn window)

- **New `session_context_turns` knob** (`profile.toml`, with an optional global `[default]` fallback): a hard cap on how many recent session turns the model sees per turn. `"all"`/absent = no cap (default, fully backward compatible), `N` = last N turns, `0` = none. Older turns stay on disk; only the per-turn request is bounded. Built on **priest `@priest-ai/core@2.6.0`**'s new `PriestConfig.sessionContextTurns` (ContextBuilder windows the replay and snaps an odd window down to a user turn so it never opens on an orphan assistant message — DashScope rejects that).
- **Uniform across modes.** Chat uses priest's windowed replay; **non-lean agent** runs apply the same cap to the bounded cross-objective history (`AgentRunner` slices `loadRecentTurns` to the last N). Lean `$skill` runs stay stateless. So the knob means the same thing whether you're in chat or agent.
- **Plumbing:** `ProfileResolver` parses `session_context_turns` (`"all"`→undefined | int ≥ 0); threaded through `MarifoldResolvedSettings` → `toPriestConfig`; global default in `ConfigSchema`/`Loader`/`Manager`; commented hint in the generated `config.toml`. Dep swapped to npm `@priest-ai/core@^2.6.0` (local link removed; `minimumReleaseAgeExclude` → 2.6.0).
- **Docs:** README `## Config` gains a full `profile.toml` properties table (provider/model/memories/mode/max_context_tokens/session_context_turns) plus the inheritable `[default]` context keys.
- **Measured live (x-runner, bailian/qwen3.6-plus):** input fell from ~30K (106%) to ~5.6K (35%) with `session_context_turns = 5`. (Output cost is separate — `/think off` cut a reasoning run from 87s/10.3K to 24s/7K; thinking is not governed by this knob.)
- Verified: core 158 (+4: turn-window parse/all/0/invalid, runtime windowed replay, agent turn-cap), service 4, tui 42 — all pass against the published npm artifact; 4 packages build clean. Per-profile `think` offered as a follow-up, not included.

## 2026-06-25 — v0.27.0 — Bounded cross-objective agent memory + agent-cost trace

- **Agent mode was stateless across objectives.** The agent engine has no session store (to avoid persisting raw `Objective:`/tool framing), so a regular task saw only `system + objective` and couldn't reference a prior turn — "save the above prompt" silently saved the wrong content (the profile's system prompt). Now **non-lean** agent tasks get a **bounded window of the recent clean session pairs** (objective → answer, the ones `appendExchange` persists — never raw framing) injected as an `## Earlier in this conversation` context block, capped by the profile's `max_context_tokens` char budget. Deterministic window — no model call, no priest change. **Lean/skill runs stay stateless** (isolated, subagent-style), matching the chat=stateful / skill=isolated split. Verified live: "save the above prompt" now writes the actual prompt.
- **Tool-output cap keeps head + tail** (`capToolOutput`) so the end of a large read/shell output survives truncation; default 100K cap left unchanged (measurement showed no intra-run explosion in real use, so lowering it would only risk reliability).
- **Agent-cost trace** (opt-in: `MARIFOLD_AGENT_TRACE=1` → `~/.marifold/agent-trace.jsonl`): per-iteration input tokens, cumulative loop size, and per-tool-result sizes. Off by default, file-based, never throws. The measurement it enabled confirmed agent loops don't explode for this workload (tool results are tiny confirmations) → eviction not needed; kept as a diagnostic for future tuning.
- Verified: core 153 (+7: history window, non-lean injection, lean-stays-stateless, head+tail cap), service 4, tui 42 — all pass; 4 packages build clean. projnavi manifest refreshed.

## 2026-06-25 — v0.26.0 — Conversation context compaction (chat) + context-budget UI

- **Bounds chat token cost.** Sessions replayed full history every turn (linear per turn, quadratic per session). Now on `@priest-ai/core@2.5.0`, which folds older turns into a running summary once a turn's input exceeds ~80% of a token budget — non-destructive (raw turns kept; summary in session metadata). Verified live: x-runner chat dropped ~33K → ~4K tokens.
- **Config:** `default.max_context_tokens` (+ `compaction_keep_turns`) and per-profile `max_context_tokens`, with a session-scoped run override. New workspaces ship `max_context_tokens = 16000`; profiles inherit it (override per-profile or globally). 16K chosen from measured turn density — ~10 turns between compactions, no thrash.
- **TUI:** footer context gauge (`ctx 62% · 9.9K/16K`), cached-input-token figure in the run summary, `/context-window` (status / `set N` / `set N default` / `set off`; `ctx` alias) and `/compact` (manual fold). Auto-compaction's summary call is cancellable via the run's abort signal.
- **Runtime:** `compactSession`, `setProfileMaxContextTokens`, cached-token usage propagation through `AgentUsage`/`sumUsage`.
- Swapped `@priest-ai/core` `^2.4.0` → `^2.5.0` (published).
- **Scope: chat.** The agent *session* (clean objective→answer pairs) is also compactable, but the agent *intra-run loop* context (plan + tool outputs) is NOT bounded by this — separate next track. Footer gauge is chat-accurate, rough in agent mode (sums input across a run's internal calls).
- Verified: core 146, tui 42, service 4 — all pass; all 4 packages build/typecheck green. DashScope/bailian returns no `cached_tokens`, so no prefix caching to exploit (16K cost-safe is correct).

## 2026-06-24 — v0.25.1 — Refactor + test hardening (model pickers, App helpers, run-routing harness)

- **`commands/model.ts` slimmed 803 → 472 lines.** The interactive provider/model pickers (`resolveModelAddTarget` and its helpers, plus the OAuth credential prompts) moved into a shared `cli/src/input/ModelPicker.ts`; `init` now imports them from there instead of from the `model` command, removing a cross-command import. Behavior unchanged.
- **`App.tsx` pure helpers extracted** to `ui/appHelpers.ts` (`errorText`, `runSummary`, `copyToClipboard`, `unwrapPath`, `skillInvocation`); 971 → 916 lines. No closures, so fully covered by `tsc` + tests.
- **Run-routing test harness.** New `tests/AppRuns.test.tsx` fakes the runtime (via `ink-testing-library`) to cover App controller logic the suite never reached before: a plain message routing to chat vs agent, `/steps` arming a one-shot forced plan, and `/stop` aborting the in-flight run. Complements `app.test.tsx` (real runtime, code-only commands).
- DEVLOG ordering repaired: the v0.24.0 entry had floated above newer entries; restored to newest-first.
- Version 0.25.0 → 0.25.1 across all packages + CLI `.version`.
- Verified: core 142, service 4, tui 35 (+4 run-routing) — all pass; all 4 packages build/typecheck green. Internal-only (refactors + tests): no behavior or public-API change.
- **Open / deferred:** the `App.tsx` hook split (`useRuns`/`useSkills`) is now verifiable through the new harness rather than TTY-blocked — see the TODO refactor backlog.

## 2026-06-24 — v0.25.0 — Adaptive planning, `/steps`, and single-line tool rows

- **Adaptive planning by default.** The forced plan phase is now gated on `AgentRunOptions.forcePlan` (off by default), so a run no longer pays for a separate planning call on trivial/transform tasks — the model reasons inline. Measured: a `make-*` run on `bailian/qwen3.6-plus` is back to ~8k tokens / 28s (vs ~10.6k / 68s with the forced plan).
- **`/steps` — one-shot forced plan.** A deterministic command (no model call inside it — honors the `/command` rule) that arms a forced, planned **agent** turn for the **next** message, then auto-disarms; running it again toggles off; it survives intervening `/commands`; the input placeholder shows `planned · …` while armed. Works for plain messages and skills.
- **Single self-updating tool rows.** A tool result now folds onto its request row (matched by `callId`): `→ read_file …` becomes `← read_file: read N from …` in place — one line, path shown once — instead of two rows. (Reducer updates the row and bumps its id so the append-only `<Static>` repaints it.)
- Version 0.24.2 → 0.25.0 across all packages + CLI `.version`.
- Verified: core 142 (+1 adaptive-skip), tui 31 (+1 tool-fold), service 4 — all pass; all 4 packages build/typecheck green. Adaptive default measured live (no plan emitted, ~8k); `/steps` confirmed live (plan shown on the next turn).
- **Open / deferred:** model-driven `update_plan` tool (structured adaptive plan the model invokes itself); `[agent].plan = "always"` config for weak-model forcing; prefix caching of the stable system+skill prefix; and the visual tool-row fold still wants a real-TTY eyeball. Refactor backlog: extract run-orchestration/command-context from `App.tsx` (971 lines) and move the model pickers out of `commands/model.ts` (803) into a shared `cli/input` module.

## 2026-06-24 — v0.24.2 — Lean skill runs + drop the verify phase (token/latency cut)

- **Lean skill execution.** Skills now run with `AgentRunOptions.lean`: terse framing and an "emit only the final output" directive, so the model stops narrating plan/preamble/reasoning across the loop. Measured on `bailian/qwen3.6-plus`: a `make-*` run dropped from `10,969` → `8,218` tokens (output `3,503` → `1,471`) and `68s` → `28s`, with the produced prompt unchanged.
- **Verify phase removed (all agent runs).** It was a separate self-grading model call that was **non-actionable** (a failed grade never retried or fixed anything) and unreliable (models rubber-stamp themselves) — pure token overhead. Real checks belong in tools the agent runs in-loop, not a final self-assessment. Runs now complete after the loop produces a final answer.
- **Plan kept for every run, including skills.** A separate `make-*` family is just one kind of skill; others may be multi-step, so the (cheap) plan stays as insurance. Adaptive, model-driven planning (a plan/todo *tool* the model invokes only when needed, Claude/Codex-style) is noted as a future, model-tier-gated option — deferred because it depends on model judgment that weak local models lack.
- Version 0.24.1 → 0.24.2 across all packages + CLI `.version`.
- Verified: core 141, tui 30, service 4 — all pass (5 AgentRunner tests updated for the no-verify/plan-kept structure); all 4 packages build/typecheck green. Lean-run token/latency drop measured live.
- **Open**: with plan kept, a skill run sits ~10.6k again (the plan call adds ~2.8k); the next lever is adaptive planning (skip the plan call on trivial/transform skills) plus prefix caching + leaner skill specs.

## 2026-06-23 — v0.24.1 — Agent runs persist a clean session turn (fixes lost skill output)

- **Fix: agent-mode output was never saved.** `createAgentRunner` built the priest engine with no session store (`createEngine(provider, false)`), so priest's persistence guard (`session && this.sessionStore`) never fired — an agent run's final answer was dropped, and resuming a session showed nothing from it. Since skills now run agentically, their generated output vanished on `--resume`.
- **Clean single-turn persistence.** Rather than re-enabling priest's raw per-iteration writes (which stored the wrapped `Objective: …Use tools…` prompt *and* duplicate turns), the runner now persists exactly one tidy pair via new `SessionResolver.appendExchange`: the **user's actual invocation** (e.g. `$make-grok-imagine-prompt #photo1 …`, passed as `AgentRunOptions.userTurn`) and the **final answer**. Run mechanics (plan, tool calls, timing/tokens) stay in ephemeral task state, not the conversation — so resumed transcripts are clean.
- README refreshed from the stale v0.14.0 framing to current (TUI-first overview, interactive `init`, `--resume`, `provider add`, agentic skills, `marifold` as the command, `timeout_seconds` default 300).
- Version 0.24.0 → 0.24.1 across all packages + CLI `.version`.
- Verified: core 141, tui 30, service 4 — all pass; all 4 packages build/typecheck green. `SessionResolver.appendExchange` verified directly (one clean user/assistant pair, retrievable); full agent→resume path confirmed live by the user.

## 2026-06-23 — v0.24.0 — Onboarding: interactive init, clearer first-run errors

- **`marifold init` picks the model interactively.** On a TTY with no `--model`, after writing the base config it runs the same provider/model picker as `marifold model add`/`model default` (exported `resolveModelAddTarget`), sets the choice as the default, removes the bootstrap `ollama/gemma4:e4b` placeholder, and offers an optional DuckDuckGo web-search toggle. This fixes the first-run error when the hardcoded default model isn't installed. Back-compat preserved: `--model` or non-TTY (scripts/CI) stays fully non-interactive.
- **Clean init output.** `printInitResult` gained `{ showModel, showNextSteps }`; interactive runs suppress the misleading bootstrap `Provider:` line and the premature "Next steps", printing the *chosen* model and a "Run `marifold` to start." line after the picker instead.
- **Not-initialized hint.** Running `marifold` (the TUI) before `init` now prints `Marifold is not initialized yet. Run \`marifold init\` to get started.` and exits, instead of showing a pointless profile picker that can't resolve a provider/model (gated on `loadedConfig.foundConfig`).
- **Unknown commands no longer launch the TUI.** A stray/unknown subcommand (e.g. `marifold frobnicate`, or a typo like `marifold marifold model`) was falling through to the bare-launch default action and opening the TUI. The root action now rejects leftover operands with `unknown command '…'`; bare `marifold` (with/without root options) still launches the TUI.
- **Production-facing hints use the packaged `marifold` binary without a package-manager prefix.**
- Version 0.23.0 → 0.24.0 across all packages + CLI `.version`.
- Verified: core 141, tui 30, service 4 — all pass; all 4 packages build/typecheck green. Non-interactive `init` paths, unknown-command rejection, and bare-launch routing checked against the built CLI. The interactive picker itself needs a real TTY (confirmed live by the user).

## 2026-06-23 — v0.23.0 — Skills run as agentic tools (read their own bundled files)

- **Skills are now real agentic tools, like Codex/Claude Code.** Invoking a skill no longer drops the user's input or runs a doc-shaped prompt; the skill body is delivered as **authoritative instructions** (new `MarifoldRunRequest.instructions` → priest `PriestRequest.context`, injected at the top of the system prompt, in both `stream` and `ask`; `AgentRunner` merges them to the front of its agent context), and the user's typed input is the turn the model acts on.
- **Skill `mode` follows the session when undeclared.** `mode` is now optional in the schema (validator returns `undefined` when absent). `startSkillRun` runs `skill.mode ?? sessionMode`, so a skill invoked in an **agent** session runs **agentically** (with tools) instead of silently downgrading to chat. A skill still pins a mode by declaring `mode:`.
- **Agent skills read their own bundled files.** The run's instructions now tell the agent the skill's folder path, so it can `read_file` siblings like `vars.toml` (the `#name` fragment table) and resolve them itself — verified live: gpt-5.4-mini read `vars.toml`, expanded `#photo1`/`#camera1`, and produced a correct one-line Midjourney prompt. No deterministic expansion in marifold (a brief `SkillVars` experiment was reverted — chat-mode skills that need tools are the author's responsibility, not marifold's to crutch).
- Root cause this fixed: variable-less skills (no `{{user_input}}`) dropped the user's input entirely, and skills ignored the session mode — so the model got a 240-line spec with no input and (in chat) couldn't read `vars.toml`. Both are gone.
- Version 0.22.0 → 0.23.0 across all packages + CLI `.version`.
- Verified: core 141, tui 30, service 4 — all pass; all 4 packages build/typecheck green. End-to-end skill run confirmed live in agent mode (`vars.toml` read + expansion + verify).
- **Differences from Codex/Claude that remain (by design):** explicit `$name` invocation (no auto-trigger by description), a narrower/approval-gated tool surface (`shell_exec` is ask-gated), and full SKILL.md injected per run rather than progressive disclosure.

## 2026-06-23 — v0.22.0 — TUI input polish: edge-triggered history, aligned menus

- **Edge-triggered history (Claude Code style).** In a multi-line draft, ↑/↓ now move the cursor between lines and only recall/advance history at the **first/last visual line**. A new `cursorVisual()` maps the cursor to its wrapped line/column using the renderer's width; column is clamped to the target line (no desired-column memory yet). Single-line input is unchanged (its one line is both first and last).
- **Fix: completion menu trapped history.** A fully-typed command (e.g. `/chat`) showed a single, already-typed suggestion whose menu hijacked ↑/↓, so history couldn't be recalled. The menu now only captures ↑/↓ when *navigable* (more than one suggestion, or the sole suggestion isn't already fully typed); otherwise ↑/↓ fall through to history.
- **Aligned, single-line list rows.** Both the `$`/`/` completion menu (`InputBox`) and the `SelectList` (`/skills`, model/profile/session pickers) now pad the name into a fixed column (capped at 28, longer names clipped) and clip the hint to the remaining width, so descriptions line up and never wrap onto a stray second line. New `ui/text.ts` with `truncate`/`padTo`. `SelectList` selection switched from full-line green inverse to `›` + accent-bold with a dim hint, matching the menu.
- Version 0.21.0 → 0.22.0 across all packages + CLI `.version`.
- Verified: core 141, tui 30 (+2: mid-draft cursor movement, history recall through a fully-typed command), service 4 — all pass; all 4 packages build/typecheck green. Menu/list alignment confirmed via a render trace.
- **Note (not a bug):** the `make-*` image-prompt skills "acknowledge instead of execute" on small local models (gemma 4 e4b/12b). Diagnosis: these skills run in **chat** mode (default; no `mode:` declared) — not agent — and are authored as ~240-line agent-onboarding specs (`## Scope` "Multi-agent…", `## Design Basis`) that small models can't follow; they echo the doc and wait for input. Fix is skill-authoring (lean, input-anchored prompts) or pinning a capable model — no marifold change.

## 2026-06-22 — v0.21.0 — Session resume, provider add, and TUI/prompt polish

- **`marifold --resume [id]`.** Bare `--resume` continues the most recent session for the resolved profile; `--resume <id>` continues that specific session (an unknown id starts fresh with a clear message). Prior turns are **replayed into the transcript** — `createInitialState` seeds the history with the reducer's own `item_${seq}` id scheme and advances `seq` past it, and a "Resumed session …" notice marks the boundary. No `--session` flag (one verb-flag; the in-TUI `/session` picker still handles interactive selection).
- **`marifold provider add`.** Interactive registry-driven flow: pick a provider (arrow-key menu with a numbered fallback), enter the Server URL (default `http://127.0.0.1:11434` for Ollama — the remote-IP/Tailscale entry point), then it saves and pings the server for reachability. API providers capture only the env-var *name* (never the secret); OAuth stays in `model add`. Keeps one provider per registry name so model ids stay clean (`ollama/model`). `--base-url`/`--api-key-env` skip the prompts.
- **Esc handling in prompts.** `InteractivePrompt.readUserMessage` gained `onEscape: 'cancel' | 'back'` (wires a keypress listener + AbortController; arrow keys carry their own names, so only a bare Esc matches). `provider add` uses it as a wizard: Esc at a text prompt steps **back** to the provider picker (new `PromptBackError`), Esc at the picker or Ctrl+C cancels.
- **`/btw` disabled in chat mode.** `runChat` never reads the steering queue, so chat-mode `/btw` silently dropped text while reporting "Queued steering". `steer` now rejects it with `/btw (steering) only applies in agent mode.`
- **Fix: `/exit` hang.** Programmatic exit left framework-owned handles alive (stdin TTY + Ink-throttle Timeout + React-scheduler Immediate, confirmed via `getActiveResourcesInfo()`), so the process never drained. `runTui` now force-exits after terminal teardown — a documented backstop, since the residual handles aren't ours to cancel.
- **TUI:** submitted-prompt accent split into `DIM_ACCENT` (border + `>` marker) so it can be tuned apart from the header accent.
- **Config:** default `timeout_seconds` 120 → 300 (template) for slow local large models; for streaming Ollama chat this is effectively a connect/first-token budget, for non-streaming/agent calls a hard cap.
- Captured deferred design notes in `TODO.md`: consult-vs-transfer, "profiles as contacts" app model, per-profile memory invariant, and schema-typed linear agent pipelines (before group chat).
- Version 0.20.0 → 0.21.0 across all packages + CLI `.version`.
- Verified: core 141, tui 28 (+1 resume-seeding regression), service 4 — all pass; all 4 packages build/typecheck green. `provider add` validated against a temp config (remote unreachable, API env-only, real local Ollama "Reachable — 6 models").
- **Open**: the interactive Esc-back loop and the `/exit` force-exit need a real-TTY manual check (auto-tests can't drive raw keystrokes). `model add` text prompts don't yet share the Esc-back affordance.

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

- **Skills are now markdown, Claude Code style.** `marifold.skill.v0` is a `SKILL.md` with a YAML frontmatter block (name/description/mode/variables) + a prompt body — no more TOML (TOML stays for config and App UI layout). New `yaml` dep in core; `schema:` is optional; `mode` defaults to `chat` (safest for weak local models). `SkillValidator` parses frontmatter+body.
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
- **Early App spec:** added the original declarative App schema and validator as a spec-only foundation; the unreleased format was later replaced by `marifold.app.v0`.
- **v0.13.0 scheduling:** `ScheduleStore` + minute-resolution `Scheduler` hosted in `marifold service`, `marifold schedule` commands, unattended approval (`ask`→deny, `[agent.unattended]` overrides), `/v1/schedules`, `lastResultSeen` flag.
- **SDK:** `@priest-ai/core` 2.4.0 (tool calling, `runWithTools`, `streamEvents`, AbortSignal, images) — spec synced to `priest` and implementations synced to Python/dotnet/rs/Swift SDKs the same day.

Verified: 111 marifold tests, 116 CLI smoke checks, live agent evals against Ollama qwen3.5:9b (native) and gemma4:e4b (auto), live `* * * * *` schedule firing inside `marifold service`.

Open: npm publish of `@priest-ai/core` 2.4.0 + removal of the workspace `link:` override; DuckDuckGo scraping is anomaly-blocked on some networks (proxy config exists; backend is pluggable); terminal image paste and agent-run service routes deferred to the TUI milestone.

Next: the `marifold` TUI (profile-centric home screen rendering the `AgentEvent` stream), then Web UI, then Apple clients.
