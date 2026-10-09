# Config Module

TOML config load/normalize/render under `packages/core/src/config/`, plus the provider registry and OAuth helpers (provider details: `.projnavi/modules/providers.md`).

Use this note for: config keys, the `[agent]`/`[web_search]`/`[paths]`/`[service]`/`[channel.telegram]` sections, config round-tripping, or per-profile agent overrides.

- `packages/core/src/config/ConfigSchema.ts` — `MarifoldConfig` and section types, `MarifoldWebSearchConfig` with `DEFAULT_WEB_SEARCH_CONFIG`/`resolveWebSearchConfig`, `LoadedMarifoldConfig`, profile/session summary types.
- `packages/core/src/config/ConfigLoader.ts` — parses TOML (`smol-toml`) into normalized config: `normalizeWebSearch`, `normalizePaths` (incl. `schedules_dir`, `skills_dir`, `apps_dir`), `normalizeService`, `normalizeChannels`, `normalizeProviders`. `parsePartialAgentConfig` (with `normalizeApprovalModes`) parses `[agent]`, `[agent.approval]`, `[agent.unattended]`, trusted folders, and tool mode; the same parser reads per-profile `[agent]` in `profile.toml`.
- `resolveAgentConfig` and `DEFAULT_AGENT_CONFIG` live in `packages/core/src/agent/ApprovalPolicy.ts`; `MarifoldRuntime.resolveAgentConfigForProfile` merges profile overrides over the global section.
- `packages/core/src/config/ConfigManager.ts` — `config set`/model/provider edits and `renderMarifoldConfig`, which round-trips `[default]`, `[paths]`, `[models]`, `[memory]`, `[agent]` (+ `.approval`/`.unattended`), `[web_search]`, `[channel.telegram]`, `[service]`, `[tui]`, and providers. `ConfigBackup.ts` backs config export/import.
- Config lives at `~/.marifold/config.toml` (`packages/core/src/workspace/WorkspacePaths.ts` holds default paths and `expandHome`); see `config.example.toml`.

Tests: `packages/core/tests/ConfigLoader.test.ts`, `packages/core/tests/ManagementCommands.test.ts`, `packages/service/tests/MarifoldServiceConfigEditing.test.ts`.
