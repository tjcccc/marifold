# Config Module

TOML config load/normalize/render, plus the provider registry and OAuth.

Use this note for: config keys, the `[agent]`/`[web_search]` sections, paths, or config round-tripping.

- `config/ConfigSchema.ts` — `MarifoldConfig` shape, `resolveAgentConfig`, `resolveWebSearchConfig`, defaults.
- `config/ConfigLoader.ts` — parse TOML (`smol-toml`) into normalized config; `normalizeAgent` (approval modes, unattended overrides, tool mode), `normalizeWebSearch` (enabled/max_results/proxy), paths incl. `schedules_dir`.
- `config/ConfigManager.ts` — `config set` and `renderMarifoldConfig` (round-trips `[agent]`, `[agent.approval]`, `[agent.unattended]`, `[web_search]`, `[paths]`).
- Config lives at `~/.marifold/config.toml`; see `config.example.toml`.
