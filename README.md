# Marifold

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.2.0 is the CLI foundation release. It provides priests-style profile chat, one-shot requests, workspace initialization, resume support, saved model options, and basic local management commands through a TypeScript CLI.

## What v0.2.0 Supports

- Marifold-branded CLI.
- One-shot request-response.
- Interactive chat.
- Chat session resume with `--resume` or `--resume last`.
- Workspace initialization.
- Basic priests-style profile loading.
- Basic profile creation and default-profile selection.
- Profile inspection.
- Basic provider/model configuration.
- Saved provider/model options through `[models].options`.
- Adding provider/model options from the CLI.
- Live model listing for Ollama and OpenAI-compatible providers where the endpoint is reachable.
- Basic config, model, provider, and session inspection commands.
- Profile-filtered session listing.
- SQLite session continuity through `@priest-ai/core`.
- A thin Marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

v0.2.0 does not include memory, web search, image upload, service/Web UI, SkillApp, Workflow, Apple apps, external-agent aliases, scheduled tasks, permission systems, visual mini-app rendering, or an agentic tool loop.

## Setup

Install and build:

```bash
pnpm install
pnpm build
```

Create local configuration:

```bash
pnpm marifold init
```

This writes `~/.marifold/config.toml`, creates `~/.marifold/profiles/default`, and keeps existing profile files if you re-run with `--force`.

Edit `~/.marifold/config.toml` if you want a provider other than the default Ollama setup.

For Ollama, make sure the configured model is available locally:

```bash
ollama pull gemma4:e4b
```

For OpenAI-compatible providers, set the configured environment variable:

```bash
export OPENAI_API_KEY="..."
```

For Anthropic:

```bash
export ANTHROPIC_API_KEY="..."
```

Do not put real API keys in tracked files.

## Commands

Run the local CLI from the workspace:

```bash
pnpm marifold ask "Hello"
pnpm marifold ask --profile default "Explain Marifold in one sentence."

pnpm marifold chat
pnpm marifold chat --profile default
pnpm marifold chat --profile default --session test-session
pnpm marifold chat --profile default --resume
pnpm marifold chat --profile default --resume last

pnpm marifold init
pnpm marifold init --provider openai --model gpt-4o-mini

pnpm marifold config show
pnpm marifold config set default.model gemma4:e4b

pnpm marifold model
pnpm marifold model list
pnpm marifold model add ollama qwen3:8b
pnpm marifold model add openai gpt-4o-mini --base-url https://api.openai.com --api-key-env OPENAI_API_KEY --default
pnpm marifold model default gemma4:e4b
pnpm marifold model default qwen3:8b --provider ollama --profile coder
pnpm marifold model default --profile coder --clear

pnpm marifold provider
pnpm marifold provider list
pnpm marifold provider ollama list
pnpm marifold provider status

pnpm marifold profile list
pnpm marifold profile show default
pnpm marifold profile init coder
pnpm marifold profile default coder

pnpm marifold session list --profile default
pnpm marifold session show test-session
pnpm marifold session rename test-session renamed-session
pnpm marifold session delete renamed-session
```

The packaged binary name is `marifold`.

Inside `marifold chat`, use `/help` for chat commands. End a line with `\` to continue a multiline message.

## Config

Default config path:

```text
~/.marifold/config.toml
```

You can override it with:

```bash
pnpm marifold --config ./config.example.toml profile list
```

Config shape:

```toml
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
timeout_seconds = 120

[models]
options = [
  "ollama/gemma4:e4b",
]

[paths]
profiles_dir = "~/.marifold/profiles"
sessions_db = "~/.marifold/sessions.db"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
```

Supported provider types:

- `ollama`
- `openai-compatible`
- `anthropic`

For `openai-compatible`, set `base_url` without the trailing `/v1`; `@priest-ai/core` appends `/v1/chat/completions`.

`marifold init` accepts `--provider`, `--provider-type`, `--model`, `--base-url`, `--api-key-env`, `--profiles-dir`, `--sessions-db`, and `--force`. Non-Ollama providers require `--model`; custom OpenAI-compatible providers also require `--base-url`.

`marifold model add` stores provider/model choices in `[models].options`. `marifold provider <name> list` asks the provider for live model names when Marifold knows how to query that provider type.

## Profiles

Marifold v0.2.0 loads priests-style profile directories:

```text
profiles/default/
  PROFILE.md
  RULES.md
  CUSTOM.md
  profile.toml
```

`PROFILE.md` defines identity, `RULES.md` defines behavior rules, and `CUSTOM.md` is optional extra system guidance.

`profile.toml` may set both `provider` and `model` to override the global default for that profile.

## Relationship to priest-typescript

Marifold depends on `@priest-ai/core` for provider calls, streaming, context assembly, and SQLite-backed session continuity.

Marifold owns only the product-level wrapper: CLI commands, Marifold config, priests-style profile directory loading, and user-facing runtime behavior.
