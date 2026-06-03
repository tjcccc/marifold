# Architecture

Marifold v0.1.1 is intentionally small. It provides a TypeScript CLI for priests-style profile chat, one-shot requests, workspace initialization, chat resume behavior, and basic local management commands powered by `@priest-ai/core`.

## Current Scope

The dependency direction is:

```text
packages/cli -> packages/core -> @priest-ai/core -> provider
```

`packages/cli` owns command parsing, terminal input/output, and the interactive chat loop.

`packages/core` owns Marifold runtime abstractions, workspace paths, TOML config loading, profile resolution, session resolution, provider adapter creation, and the bridge to `@priest-ai/core`.

`@priest-ai/core` remains Marifold-agnostic. Marifold depends on it; it does not know about Marifold.

## v0.1.1 Boundaries

The runtime layer is thin. `MarifoldRuntime` resolves config/profile/session settings and delegates ask/stream execution to `PriestEngine`.

Config, profile, model, provider, and session commands are local management surfaces. They do not introduce agent tools, service APIs, or web/app runtimes.

Profiles are loaded from priests-style directories:

```text
profiles/default/
  PROFILE.md
  RULES.md
  CUSTOM.md
  profile.toml
```

SQLite session continuity is reused from `@priest-ai/core`.

## Future Areas

These are planned areas, but they are not implemented in v0.1.1:

```text
apps/web
  Future React Web UI for chat, profiles, and SkillApp panels.

apps/apple
  Future SwiftUI macOS and iOS clients.

SkillApp runtime
  Future system for turning reusable skills into structured mini apps.

Workflow runtime
  Future system for manual/scheduled multi-step runs.

External-agent aliases
  Future runners for Codex, Claude Code, and similar tools.
```

Do not create empty future app directories until implementation begins.
