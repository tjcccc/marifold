# AGENTS

## Project

marifold is a local-first, single-owner personal AI workspace: profiles, conversations, Skills and SkillApps, scheduled runs, and device-hosted workspaces that connect the owner's devices. Every ordinary message runs through one approval-aware agent path, rendered by the TUI (primary surface), the CLI, and the Web UI. Read `docs/architecture.md` for runtime pieces, package responsibilities, trust boundaries, and terms, and the newest `DEVLOG.md` entries for recent history.

## Stack

- TypeScript (TypeScript 7 native compiler), Node.js 24, pnpm 12.9.1 workspace
- `@priest-ai/core` as the model/runtime foundation
- Fastify for the HTTP service; Ink/React for the TUI; React and Vite for the Web UI
- Biome for lint rules (`biome.json`); Vitest for tests

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, memory, agent (runner/tools/approval), task-state, and session logic.
- `packages/service` contains the Fastify API, split into route modules. Keep it a thin transport layer over `packages/core`. It defaults to loopback; explicit non-loopback binds accept only direct private LAN, link-local, IPv6 ULA, and Tailscale peers, and same-origin hosted Web access needs no CORS entry.
- `packages/cli` contains terminal commands and interactive CLI behavior; bare `marifold` launches `packages/tui`, the Ink renderer of the `AgentEvent` contract, which must hold no model-side logic.
- `packages/client` is the typed HTTP/SSE client shared by the TUI, CLI, and Web UI; it must not depend on core at runtime.
- `packages/workspace-protocol` holds wire types, identities, signing, and encryption shared by core and `apps/bridge`, the relay server; keep both free of marifold runtime logic. Workspace hosts keep credentials and data; guests never receive them, and paired devices must run the same release.
- `@priest-ai/core` (../priest-typescript) owns model-side primitives: providers, tool-call transport, streaming, context assembly. Changes there must be synced to the priest spec repository.
- The `AgentEvent` union in `packages/core/src/agent/AgentEvents.ts` is the render contract for all future clients; keep it renderer-agnostic.
- Agent runs must not write profile memory; task state stays ephemeral.
- `apps/web` contains the browser UI — a second renderer of the same contracts the TUI renders. All data flows over the service HTTP API; `src/api/types.ts` is the only file that may import from `@marifold/core`, and only with `import type`.
- Uploads stay staged read-only and out of Agent prompts: `inspect_attachment`, `read_attachment`, and `search_attachment` expose bounded views, complete document operations run local programs against the staged path, and files under the run output directory become artifacts. Preserve this provider-independent resource boundary for Office files, PDFs, ebooks, archives, and future formats.
- Raw provider `api_key` values never cross the wire: service routes expose env-var names and boolean presence flags only; key values are edited via the CLI or config file.
- marifold is permanently a personal, single-owner BYOK/BYO-auth agent. Remote access connects that owner's devices; never add multi-tenant accounts, credential pooling, subscription/API relays, quota resale, or public-internet service exposure.
- Preserve the documented SkillApp v1/v2 static compiler and capability boundary. Host paths require explicit static read declarations and stay server-only. The protected built-in SkillApp builder is the sole App-specific persistent mutation: it uses a dedicated approve-once tool to validate and atomically install one complete bundle. Do not add other effectful App actions, dynamic persistent grants, Workflow, Apple apps, external-agent aliases, or provider-owned model deletion until that area is explicitly in scope.

## Versioning

- marifold uses synchronized Semantic Versioning: root `package.json` defines the release version. Keep every workspace manifest (`packages/*/package.json` and `apps/*/package.json`, including private packages) and `.version(...)` in `packages/cli/src/index.ts` equal to it. New workspace packages join this policy automatically. Run `pnpm check:versions` before publishing.
- For a release checkpoint, update the matching `DEVLOG.md` heading and refresh `pnpm-lock.yaml` with pnpm when the manifest changes affect it.
- After a version bump, rebuild from clean output before publishing. Verify packed package versions and the packed CLI's `--version` match the release version.
- Publish only after `pnpm gate` (full gate on a clean, committed tree) passed on that exact commit. Every public package's `prepublishOnly` runs `scripts/release-check.mjs`, which refuses a dirty tree, a commit the gate has not passed, mismatched versions, or a built CLI reporting another version.

## Code style

- Every control-flow body has braces, including single statements: `if (done) { return; }`, never `if (done) return;`. The same applies to `else`, loops, and arrow-function bodies containing them. `pnpm lint` (Biome `useBlockStatements`, configured in `biome.json`) enforces it; `pnpm exec biome lint --write --unsafe .` applies the fix.
- No explicit `any`, no import cycles, and type-only imports use `import type` (Biome `noExplicitAny`, `noImportCycles`, `useImportType`; `pnpm exec biome lint --write .` fixes import style).
- Outside `apps/web/src/api/types.ts`, the Web UI must not import `@marifold/core` or `@marifold/service`; a `noRestrictedImports` override in `biome.json` enforces it.
- File-size ratchet: source files stay at or below 800 lines. Files recorded in `.file-size-baseline.json` may shrink but not grow; after splitting one, run `node scripts/check-file-sizes.mjs --update` to lower its recorded size.
- UI changes follow `spec/ui.md`: Web design tokens, the TUI palette, and cross-surface consistency.
- Markdown prose is not hard-wrapped: one paragraph or list item per source line. `pnpm lint` runs `scripts/markdown-wrap.mjs`; `node scripts/markdown-wrap.mjs --fix` joins wrapped lines. Code blocks, tables, and explicit hard breaks are kept.

## Validation

Enable the pre-commit hook once per clone with `git config core.hooksPath .githooks`; it runs `pnpm lint` (after any global pre-commit) before each commit. `git commit --no-verify` and clones without the setting bypass it.

The full gate is `pnpm lint && pnpm -r typecheck && pnpm -r build && pnpm -r test`; run it before finishing a milestone, and at least lint + typecheck + build for smaller changes. Add targeted tests when practical.

Note: `packages/service` tests resolve `@marifold/core` from its built `dist`, so rebuild core (`pnpm --filter @marifold/core build`) before service tests can observe core source changes.
