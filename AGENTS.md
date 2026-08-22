# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.35.x implements the TypeScript CLI + TUI foundation, priests-style structured profile memory, an approval-aware agent loop (native tool calling plus a control-block fallback), chat tool parity (web search, file reading, images), markdown skills, scheduled unattended runs, the Telegram channel, and a loopback-only Fastify service API with optional bearer auth, a CORS origin allowlist, and live agent-run routes (SSE `AgentEvent` stream, approval/steer/cancel POSTs) documented in `docs/service-api.md`.

v0.36–v0.39.x add the browser Web UI (`apps/web`, served statically by the service): agent chat with image/text-file attachments, session previews, collapsible sidebars, profile avatars and creation, and a three-column Config screen with provider/model management routes.

v0.40–v0.44.x add the `xai` provider (SuperGrok subscription OAuth against `api.x.ai/v1`) and a uniform per-provider `proxy` config key (requires `@priest-ai/core` >= 2.7.0, which added the fetch dispatcher hook), plus Web UI composer parity with the TUI: avatar crop/compress (stored under `<profile>/assets/`), `$skill` inline highlight + autocomplete, a 15-command `/command` palette with two new service routes (profile memory add, session compact), and a two-row ChatGPT-style composer layout.

v0.45.x adds lazy built-in `$skill-manager` guidance for ordinary agent prompts that mention skills, with multilingual detection and resolved profile/global paths shared across TUI, CLI, service, channels, and Web UI agent runs.

v0.46.x adds shared image validation and request optimization across TUI, CLI, service, and Web UI paths, including conservative resizing/encoding, attachment limits, browser-side preprocessing, and the one-turn `/attach-original` bypass. v0.46.1 fixes Web UI Markdown tables, composer autocomplete caret alignment, and immediate/durable new-session sidebar updates. v0.47.x adds the macOS-style desktop shell, clean routes, progress/final response emphasis, caret-aware completion with existing arguments, explicit Markdown hard breaks, and submit-time transcript following.

v0.48.x adds durable transcript image replay and galleries, response/code copying, IME-safe composer behavior, in-place historical prompt regeneration that preserves later exchanges, and persistent session rename/pin/delete controls.

v0.49.x completes the desktop Web workspace with profile/session search, archive views, per-session drafts, authenticated lazy transcript images, global agent/web-search/appearance settings, accessible keyboard/dialog behavior, safe active-request deletion, and isolated Chromium regression coverage.

v0.50.x adds local Web extraction for modern Word/Excel/PowerPoint attachments, bounded read-only original-file staging for agent runs, capability-scoped per-run workspaces, fail-closed macOS shell sandboxing, one-time approved `uv` package installation into disposable Python environments, and deterministic service shutdown/listen-failure cleanup.

v0.51.x resolves direct `$skill` invocations in core with history-isolated execution and narrow read-only bundled-file access, and adds contact-style Web profile navigation with response previews/activity times, persistent profile pinning, and double-confirmed profile removal that retains conversation history.

v0.52.x adds the App MVP: global `~/.marifold/apps/<name>/app.toml` bundles, normalized definitions and transcript-free streamed Skill actions through the service, explicit actor profiles per action, and portable layout trees in the persistent Web workspace shell. Per-app execution controls independently gate thinking, memory, and profile context.

v0.53.x enables bearer-protected non-loopback service binding for trusted LAN or tailnet access. The Web shell keeps named same-origin or remote Marifold servers with independent tokens and remounts its data views when the active connection changes.

v0.54.x adds optional model-authored clarification questions through one renderer-neutral interaction contract, with batched standalone question interfaces in the TUI and Web UI. It also restores normal user-home semantics for `~` and `$HOME` while retaining capability-scoped run isolation.

v0.55–v0.57.x add interruptible runs and multi-select clarification answers, managed foreground/daemon service lifecycle with restartable safe launch options, idempotent empty-session creation, live signed-in ChatGPT model discovery, strict provider-error surfacing through `@priest-ai/core` 3.0.1, and private-network-only tokenless non-loopback access with explicit authenticated `--public` exposure.

The service defaults to loopback. Explicit non-loopback binds accept direct private LAN, link-local, IPv6 ULA, and Tailscale peers by default; public-source access requires `--public` plus resolved bearer authentication. Same-origin hosted Web access needs no CORS entry.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation
- Fastify for the local HTTP service

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, memory, agent (runner/tools/approval), task-state, and session logic.
- `packages/service` contains the default-loopback Fastify API and its authenticated opt-in remote binding. Keep it as a thin transport layer over `packages/core`.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- `@priest-ai/core` (../priest-typescript) owns model-side primitives: providers, tool-call transport, streaming, context assembly. Changes there must be synced to the priest spec repository.
- The `AgentEvent` union in `packages/core/src/agent/AgentEvents.ts` is the render contract for all future clients; keep it renderer-agnostic.
- Agent runs must not write profile memory; task state stays ephemeral.
- `apps/web` contains the browser UI — a second renderer of the same contracts the TUI renders. All data flows over the service HTTP API; `src/api/types.ts` is the only file that may import from `@marifold/core`, and only with `import type`.
- Raw provider `api_key` values never cross the wire: service routes expose env-var names and boolean presence flags only; key values are edited via the CLI or config file.
- Do not expand App beyond the documented `marifold.app.v0` MVP or implement Workflow, Apple apps, external-agent aliases, effectful App actions, or provider-owned model deletion until that area is explicitly in scope.

## Validation

The full gate is `pnpm -r typecheck && pnpm -r build && pnpm -r test`; run it before finishing a milestone, and at least typecheck + build for smaller changes. Add targeted tests when practical.

Note: `packages/service` tests resolve `@marifold/core` from its built `dist`, so rebuild core (`pnpm --filter @marifold/core build`) before service tests can observe core source changes.
