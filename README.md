# Marifold

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.0.1 is the foundation release. It only provides priests-style profile chat and one-shot requests through a TypeScript CLI.

## What v0.0.1 Supports

- Marifold-branded CLI.
- One-shot request-response.
- Interactive chat.
- Basic priests-style profile loading.
- Basic provider/model configuration.
- SQLite session continuity through `@priest-ai/core`.
- A thin Marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

v0.0.1 does not include SkillApp, Workflow, Web UI, Apple apps, external-agent aliases, scheduled tasks, permission systems, visual mini-app rendering, or an agentic tool loop.

## Setup

Install and build:

```bash
pnpm install
pnpm build
```

Create local configuration:

```bash
mkdir -p ~/.marifold
cp config.example.toml ~/.marifold/config.toml
mkdir -p ~/.marifold/profiles
cp -R examples/profiles/default ~/.marifold/profiles/default
```

Edit `~/.marifold/config.toml` for your provider and model.

For Ollama, make sure the configured model is available locally:

```bash
ollama pull llama3.2
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

pnpm marifold profile list
pnpm marifold session list
```

The packaged binary name is `marifold`.

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
model = "llama3.2"
profile = "default"
timeout_seconds = 120

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

## Profiles

Marifold v0.0.1 loads priests-style profile directories:

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
