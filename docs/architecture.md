# Architecture

Marifold v0.7.0 is intentionally small. It provides a TypeScript CLI for priests-style profile chat, one-shot requests, workspace initialization, chat resume behavior, saved model options, model validation, model-driven and explicit configurable profile memory, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API routing, and basic local management commands powered by `@priest-ai/core`.

## Current Scope

The dependency direction is:

```text
packages/cli -> packages/core -> @priest-ai/core -> provider
```

`packages/cli` owns command parsing, terminal input/output, and the interactive chat loop.

`packages/core` owns Marifold runtime abstractions, workspace paths, TOML config loading, profile resolution, profile memory storage/selection/control-block application, session resolution, provider adapter creation, and the bridge to `@priest-ai/core`.

`@priest-ai/core` remains Marifold-agnostic. Marifold depends on it; it does not know about Marifold.

## v0.7.0 Boundaries

The runtime layer is thin. `MarifoldRuntime` resolves config/profile/session settings, selects profile memory, and delegates ask/stream execution to `PriestEngine`.

Config, profile, model, provider, and session commands are local management surfaces. They do not introduce agent tools, service APIs, or web/app runtimes.

Model validation checks local configuration and provider model-list endpoints where available. It does not delete, pull, or mutate local provider storage.

Profiles are loaded from priests-style directories:

```text
profiles/default/
  PROFILE.md
  RULES.md
  CUSTOM.md
  profile.toml
  memories/
    user.jsonl
    preferences.jsonl
    auto_short.jsonl
```

Marifold owns the profile memory file meaning and passes selected memory to `@priest-ai/core` through `PriestRequest.memory`. The memory path can be disabled per profile through `profile.toml` or per run through `--no-memories`. When enabled, Marifold injects memory policy instructions, strips hidden `<memory_save>` and `<memory_forget>` blocks from visible output and saved session history, then applies those JSONL mutations after the turn. A conservative prompt fallback saves direct self-identification such as the user's name. `@priest-ai/core` remains generic and only assembles memory into provider messages.

Thinking mode is a provider option selected by Marifold and only forwarded to known compatible providers. It does not change context assembly or introduce agent behavior.

SQLite session continuity is reused from `@priest-ai/core`.

## Future Areas

These are planned areas, but they are not implemented in v0.7.0:

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
