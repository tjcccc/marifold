# Marifold

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.7.0 is the CLI foundation release. It provides priests-style profile chat, one-shot requests, workspace initialization, resume support, saved model options, model validation, model-driven and explicit profile memory commands, configurable memory recall, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API support, and command smoke coverage through a TypeScript CLI.

For product direction and future scope, see [docs/vision.md](docs/vision.md).

## What v0.7.0 Supports

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
- Interactive provider/model selection with OAuth setup for GitHub Copilot and ChatGPT-style providers.
- GitHub Copilot chat through `/chat/completions` and Responses API routing for models such as `gpt-5.4-mini`.
- Live model listing for Ollama and OpenAI-compatible providers where the endpoint is reachable.
- Model validation against configured providers and live model lists where available.
- Profile-scoped memory files in `memories/user.jsonl`, `memories/preferences.jsonl`, and `memories/auto_short.jsonl`.
- Model-driven memory saves and forgets through hidden `<memory_save>` and `<memory_forget>` blocks.
- Conservative prompt fallback for direct self-identification such as `my name is Jack`.
- Explicit chat memory commands for remember, soft-forget, and permanent delete.
- Memory injection through the `@priest-ai/core` request `memory` lane.
- Memory recall controls through `[memory].context_limit`, `profile.toml` `memories = false`, and `--no-memories`.
- Thinking mode controls through `[default].think`, `ask/chat --think [true|false]`, and chat `/think on|off`.
- Basic config, model, provider, and session inspection commands.
- Profile-filtered session listing.
- Automated CLI command smoke checks through `pnpm command-test`.
- SQLite session continuity through `@priest-ai/core`.
- A thin Marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

v0.7.0 does not include full memory consolidation, broad automatic memory extraction, web search, image upload, service/Web UI, SkillApp, Workflow, Apple apps, external-agent aliases, scheduled tasks, provider-owned model deletion, permission systems, visual mini-app rendering, or an agentic tool loop.

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

## Development Checks

```bash
pnpm build
pnpm typecheck
pnpm test
```

For CLI smoke checks that avoid live model calls, see [docs/smoke.md](docs/smoke.md).

## Commands

Run the local CLI from the workspace:

```bash
pnpm marifold ask "Hello"
pnpm marifold ask --profile default "Explain Marifold in one sentence."
pnpm marifold ask --no-memories "Format this JSON"
pnpm marifold ask --think true "Solve step by step."

pnpm marifold chat
pnpm marifold chat --profile default
pnpm marifold chat --profile default --no-memories
pnpm marifold chat --profile default --think true
pnpm marifold chat --profile default --session test-session
pnpm marifold chat --profile default --resume
pnpm marifold chat --profile default --resume last

pnpm marifold init
pnpm marifold init --provider openai --model gpt-4o-mini

pnpm marifold config show
pnpm marifold config set default.model gemma4:e4b

pnpm marifold model
pnpm marifold model list
pnpm marifold model add
pnpm marifold model add ollama qwen3:8b
pnpm marifold model add openai gpt-4o-mini --base-url https://api.openai.com --api-key-env OPENAI_API_KEY --default
pnpm marifold model validate
pnpm marifold model validate ollama/gemma4:e4b
pnpm marifold model validate gemma4:e4b --provider ollama
pnpm marifold model default
pnpm marifold model default --profile coder
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

Memory commands available inside chat:

```text
/think on             Enable thinking mode for supported providers.
/think off            Disable thinking mode.
/remember <text>       Save short-term memory.
/remember user <text>  Save durable user memory.
/remember pref <text>  Save durable preference memory.
/forget <query>        Soft-forget active memory by text, id, or conflict key.
/delete-memory <query> Permanently delete matching JSONL memory records.
```

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
think = false

[models]
options = [
  "ollama/gemma4:e4b",
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "~/.marifold/profiles"
sessions_db = "~/.marifold/sessions.db"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
```

Supported provider adapter types:

- `ollama`
- `openai-compatible`
- `anthropic`

The `model add` picker is seeded from the priests provider registry: Ollama, llama.cpp, LM Studio, Rapid-MLX, OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, Perplexity, Cohere, Together AI, Alibaba Bailian, Alibaba Cloud, MiniMax, Kimi, OpenRouter, GitHub Copilot OAuth, ChatGPT OpenAI OAuth, and custom OpenAI-compatible endpoints.

For `openai-compatible`, `base_url` may be the API root such as `https://api.openai.com`, or a versioned compatibility root such as `https://generativelanguage.googleapis.com/v1beta/openai`. Marifold builds the final `/chat/completions`, `/responses`, and `/models` URLs from it.

`marifold init` accepts `--provider`, `--provider-type`, `--model`, `--base-url`, `--api-key-env`, `--profiles-dir`, `--sessions-db`, and `--force`. Non-Ollama providers require `--model`; custom OpenAI-compatible providers also require `--base-url`.

`marifold model add` stores provider/model choices in `[models].options`. With no arguments it starts an interactive provider picker, prompts for OAuth/manual credentials for OAuth providers such as GitHub Copilot and ChatGPT when no usable credential exists, then shows live provider models when Marifold can list them. Saved credentials use local `[providers.<name>]` fields such as `api_key`, `oauth_token`, and `api_key_expires_at`; existing `api_key_env` configs still work and environment variables take precedence at runtime. The positional `marifold model add <provider> <model>` form remains available for scripts. `marifold provider <name> list` asks the provider for live model names when Marifold knows how to query that provider type.

For GitHub Copilot, Marifold offers models compatible with the current chat adapters. Models such as `gpt-5.4` use `/chat/completions`; responses-only models such as `gpt-5.4-mini` use `/responses`.

For GitHub Copilot OAuth, Marifold refreshes the short-lived Copilot IDE token from the saved `oauth_token` before provider requests when the saved token is expired or close to expiry. Pasted Copilot IDE tokens without an `oauth_token` cannot be refreshed automatically.

`marifold model validate` validates the default or profile-resolved provider/model. It checks configured provider access and uses live model lists for Ollama and OpenAI-compatible providers when reachable.

`marifold model default` starts an interactive selector over added models and includes `Add new model...`, which runs the same provider/model setup flow as `marifold model add` before setting the global default. `marifold model default --profile <name>` starts a profile selector with `Use default (<global provider/model>)`, saved models, and `Add new model...`; choosing `Use default` clears the profile override so new sessions for that profile use the global default.

`[memory].context_limit` caps the combined memory text injected into one provider request. Set it to `0` for unlimited memory injection. `[memory].size_limit` is reserved for future automatic short-term memory trimming.

`[default].think` controls default thinking mode. Thinking is passed as provider option `think` only to providers known to support it: Ollama-compatible providers plus `bailian` and `alibaba_cloud`.

## Profiles

Marifold v0.7.0 loads priests-style profile directories:

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

`PROFILE.md` defines identity, `RULES.md` defines behavior rules, and `CUSTOM.md` is optional extra system guidance.

`profile.toml` may set both `provider` and `model` to override the global default for that profile.

`profile.toml` may also set `memories = false` for tool profiles that should not receive profile memory. Per-run `--no-memories` disables memory for one `ask` or `chat` invocation.

`memories/user.jsonl` stores durable user facts, `memories/preferences.jsonl` stores durable preferences, and `memories/auto_short.jsonl` stores short-term notes. Marifold creates these files for existing profiles when memory is first prepared, read, or written. When memory is on, Marifold asks the model to emit hidden memory control blocks for useful saves or forgets, strips those blocks from visible replies and session history, and applies the JSONL updates after the turn. A conservative fallback also saves direct self-identification such as `my name is Jack` even when the model does not emit a block. Marifold also reads legacy Markdown memory files in `memories/user.md`, `memories/preferences.md`, `memories/notes.md`, and `memories/auto_short.md` as read-only fallback prompt context.

## Relationship to priest-typescript

Marifold depends on `@priest-ai/core` for provider calls, streaming, context assembly, and SQLite-backed session continuity.

Marifold owns only the product-level wrapper: CLI commands, Marifold config, priests-style profile directory loading, profile memory selection, and user-facing runtime behavior.
