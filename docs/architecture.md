# Architecture

Marifold v0.9.0 is still intentionally small, but memory is now a first-class local subsystem. It provides a TypeScript CLI for priests-style profile chat, one-shot requests, workspace initialization, chat resume behavior, saved model options, model validation, structured profile memory, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API routing, config backup/import, and local management commands powered by `@priest-ai/core`.

## Current Scope

The dependency direction is:

```text
packages/cli -> packages/core -> @priest-ai/core -> provider
```

`packages/cli` owns command parsing, terminal input/output, and the interactive chat loop.

`packages/core` owns Marifold runtime abstractions, workspace paths, TOML config loading, profile resolution, profile memory storage/selection/control-block application, session resolution, provider adapter creation, and the bridge to `@priest-ai/core`.

`@priest-ai/core` remains Marifold-agnostic. Marifold depends on it; it does not know about Marifold.

## v0.9.0 Boundaries

The runtime layer is thin. `MarifoldRuntime` resolves config/profile/session settings, selects profile memory with the current prompt and thinking mode, and delegates ask/stream execution to `PriestEngine`.

Config, profile, model, provider, and session commands are local management surfaces. Config export/import copies local config, profile files, memories, and optional sessions; it does not introduce service APIs or cloud sync. These commands do not introduce agent tools or web/app runtimes.

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

Marifold owns the profile memory file meaning and passes selected memory to `@priest-ai/core` through `PriestRequest.memory`. The memory path can be disabled per profile through `profile.toml` or per run through `--no-memories`. When enabled, Marifold injects memory policy instructions, strips hidden `<memory_save>` and `<memory_forget>` blocks from visible output and saved session history, applies JSONL mutations after the turn, applies conservative prompt fallback extraction, applies prompt-driven forgets, and trims low-priority short-term memory.

Structured memory is stored in JSONL under profile directories. The current memory subsystem is integrated inside `packages/core/src/memory`, but it is intentionally package-shaped: schema, persistence, selection, prompt/control extraction, and policy remain separated enough to extract into a future `@marifold/memory` package once agent/task memory requirements settle.

Memory is context, not authority. Human-authored profile files and the current user message outrank memory. Normal recall includes priority `0..3`, thinking mode includes priority `0..10`, and simple greetings include only priority `0` memories.

Thinking mode is a provider option selected by Marifold and only forwarded to known compatible providers. It does not change context assembly or introduce agent behavior.

SQLite session continuity is reused from `@priest-ai/core`.

## Future Areas

These are planned areas, but they are not implemented in v0.9.0:

```text
apps/web
  Future React Web UI for chat, profiles, and SkillApp panels.

apps/apple
  Future SwiftUI macOS and iOS clients.

SkillApp runtime
  Future system for turning reusable skills into schema-defined GUI mini apps.

Workflow runtime
  Future system for composing native profiles, skills, models, and external agents into multi-step runs.

External-agent aliases
  Future alias profiles that launch, wrap, delegate to, or compose with Codex, Claude Code, and similar tools.

Task memory
  Future ephemeral task/run state for agent loops: objective, plan, progress, tool observations, decisions, blockers, and next action. This should not automatically persist into durable profile memory.
```

Do not create empty future app directories until implementation begins.

For the product direction behind these future areas, see [vision.md](vision.md).
