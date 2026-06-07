# Marifold

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.10.0 is the service and task-state foundation release. It provides priests-style profile chat, one-shot requests, workspace initialization, resume support, saved model options, model validation, structured profile memory with priority/relevance recall, model-driven and prompt-fallback memory updates, conflict-key supersession, short-term trimming, memory inspection, thinking mode controls, OAuth provider setup, GitHub Copilot Responses API support, config backup/import, profile and session management polish, a loopback-only Fastify service API, ephemeral task-state storage for future agents, and command/eval coverage through a TypeScript CLI.

For product direction and future scope, see [docs/vision.md](docs/vision.md) and [docs/roadmap.md](docs/roadmap.md).

## What v0.10.0 Supports

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
- Removing saved provider/model options from Marifold config without deleting provider-owned model files.
- Interactive provider/model selection with OAuth setup for GitHub Copilot and ChatGPT-style providers.
- GitHub Copilot chat through `/chat/completions` and Responses API routing for models such as `gpt-5.4-mini`.
- Live model listing for Ollama and OpenAI-compatible providers where the endpoint is reachable.
- Model validation against configured providers and live model lists where available.
- Full model validation over saved models plus global/profile defaults.
- Profile-scoped structured memory files in `memories/user.jsonl`, `memories/preferences.jsonl`, and `memories/auto_short.jsonl`.
- Rich memory metadata: priority, confidence, stability, source, source type, scope, timestamps, evidence, reason, conflict keys, and supersession status.
- Model-driven memory saves and forgets through hidden `<memory_save>` and `<memory_forget>` blocks.
- Conservative prompt fallback for explicit names, favorite/preferred facts, response-style preferences, meeting times, and prompt-driven forget requests.
- Priority/relevance recall with simple-prompt gating, thinking-mode priority expansion, expiry handling, and `[memory].context_limit`.
- Conflict-key canonicalization and open-slot updates such as `user.name`, `user.favorite_color`, `user.favorite_editor`, `preferences.reply_style`, and `auto_short.project_meeting_time`.
- Automatic low-priority short-term trimming through `[memory].size_limit`.
- Explicit chat memory commands for remember, soft-forget, and permanent delete.
- Profile memory inspection through `profile memory`.
- Memory injection through the `@priest-ai/core` request `memory` lane.
- Memory recall controls through `[memory].context_limit`, `profile.toml` `memories = false`, and `--no-memories`.
- Thinking mode controls through `[default].think`, `ask/chat --think [true|false]`, and chat `/think on|off`.
- Basic config, model, provider, and session inspection commands.
- Config backup and restore for config, profiles, memories, and optional sessions.
- Profile rename and delete commands for stored profiles.
- Profile-filtered session listing.
- Bulk session clearing with profile/date/keep-last filters.
- Loopback-only local HTTP service through `marifold service`.
- Service routes for health/status, sanitized config, providers, models, profiles, memories, sessions, ask, and streaming chat.
- Server-sent event streaming for chat chunks through `/v1/chat/stream`.
- Ephemeral task-state storage under `[paths].tasks_dir`, defaulting to `~/.marifold/tasks`.
- Task API routes for objective, status, plan, events, summary, next action, and profile/session references.
- Automated CLI command smoke checks through `pnpm command-test`.
- Provider-backed memory eval script through `pnpm memory-eval -- --provider ollama --model gemma4:e4b`.
- SQLite session continuity through `@priest-ai/core`.
- A thin Marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

v0.10.0 does not include semantic/vector retrieval, memory encryption, full memory edit UI, Web UI, SkillApp, Workflow, Apple apps, external-agent aliases, web search, image upload, scheduled tasks, provider-owned model deletion, remote service auth, service daemon packaging, permission systems, visual mini-app rendering, or an agentic tool loop.

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

For CLI smoke checks that avoid live model calls, see [docs/smoke.md](docs/smoke.md). For provider-backed memory checks after `pnpm build`, run:

```bash
pnpm memory-eval -- --provider ollama --model gemma4:e4b --suite professional
```

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
pnpm marifold config export ./marifold-backup.json --include-sessions
pnpm marifold config import ./marifold-backup.json --force

pnpm marifold model
pnpm marifold model list
pnpm marifold model add
pnpm marifold model add ollama qwen3:8b
pnpm marifold model add openai gpt-4o-mini --base-url https://api.openai.com --api-key-env OPENAI_API_KEY --default
pnpm marifold model validate
pnpm marifold model validate --all
pnpm marifold model validate ollama/gemma4:e4b
pnpm marifold model validate gemma4:e4b --provider ollama
pnpm marifold model rm openai/gpt-4o-mini
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
pnpm marifold profile memory default
pnpm marifold profile memory default --all --limit 100
pnpm marifold profile init coder
pnpm marifold profile rename coder writer
pnpm marifold profile delete writer --yes
pnpm marifold profile default coder

pnpm marifold session list --profile default
pnpm marifold session show test-session
pnpm marifold session rename test-session renamed-session
pnpm marifold session delete renamed-session
pnpm marifold session clear --profile default --keep-last 10 --yes

pnpm marifold service
pnpm marifold service --host 127.0.0.1 --port 32140
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
tasks_dir = "~/.marifold/tasks"

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

`marifold init` accepts `--provider`, `--provider-type`, `--model`, `--base-url`, `--api-key-env`, `--profiles-dir`, `--sessions-db`, `--tasks-dir`, and `--force`. Non-Ollama providers require `--model`; custom OpenAI-compatible providers also require `--base-url`.

`marifold service` starts a Fastify HTTP service bound to `127.0.0.1:32140` by default. v0.10.0 intentionally accepts loopback hosts only. The first API surface is `/health` and `/v1/*` routes for app-client foundations: sanitized config/provider/model views, profiles, memories, sessions, ask/chat, SSE streaming chat, and task state.

`marifold config export <file>` writes config, profile files, memory files, and optional sessions into a local JSON backup. Treat backups as sensitive if your config contains saved `api_key` or `oauth_token` values.

`marifold model add` stores provider/model choices in `[models].options`. With no arguments it starts an interactive provider picker, prompts for OAuth/manual credentials for OAuth providers such as GitHub Copilot and ChatGPT when no usable credential exists, then shows live provider models when Marifold can list them. Saved credentials use local `[providers.<name>]` fields such as `api_key`, `oauth_token`, and `api_key_expires_at`; existing `api_key_env` configs still work and environment variables take precedence at runtime. The positional `marifold model add <provider> <model>` form remains available for scripts. `marifold provider <name> list` asks the provider for live model names when Marifold knows how to query that provider type.

For GitHub Copilot, Marifold offers models compatible with the current chat adapters. Models such as `gpt-5.4` use `/chat/completions`; responses-only models such as `gpt-5.4-mini` use `/responses`.

For GitHub Copilot OAuth, Marifold refreshes the short-lived Copilot IDE token from the saved `oauth_token` before provider requests when the saved token is expired or close to expiry. Pasted Copilot IDE tokens without an `oauth_token` cannot be refreshed automatically.

`marifold model rm <provider/model>` removes a saved model option from Marifold config. It does not delete provider-owned model files, pull caches, or remote model access.

`marifold model validate` validates the default or profile-resolved provider/model. It checks configured provider access and uses live model lists for Ollama and OpenAI-compatible providers when reachable. `marifold model validate --all` validates every saved model option plus global and profile-specific defaults.

`marifold model default` starts an interactive selector over added models and includes `Add new model...`, which runs the same provider/model setup flow as `marifold model add` before setting the global default. `marifold model default --profile <name>` starts a profile selector with `Use default (<global provider/model>)`, saved models, and `Add new model...`; choosing `Use default` clears the profile override so new sessions for that profile use the global default.

`[memory].context_limit` caps the combined memory text injected into one provider request. Set it to `0` for unlimited memory injection. `[memory].size_limit` caps `memories/auto_short.jsonl`; low-priority short-term entries are trimmed first while priority `0` entries are preserved where possible.

`[default].think` controls default thinking mode. Thinking is passed as provider option `think` only to providers known to support it: Ollama-compatible providers plus `bailian` and `alibaba_cloud`.

## Profiles

Marifold v0.10.0 loads priests-style profile directories:

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

`memories/user.jsonl` stores durable user facts, `memories/preferences.jsonl` stores durable preferences, and `memories/auto_short.jsonl` stores short-term notes. Each JSONL entry stores rich metadata such as `priority`, `confidence`, `stability`, `source`, `source_type`, `scope`, timestamps, optional `evidence`, optional `reason`, optional `conflict_key`, and supersession status.

Memory is context, not authority. Human-authored profile files and the current user message outrank memory. Prompt injection receives compact grouped memory blocks rather than raw JSON.

Marifold creates memory files for existing profiles when memory is first prepared, read, or written. When memory is on, Marifold asks the model to emit hidden memory control blocks for useful saves or forgets, strips those blocks from visible replies and session history, applies JSONL updates after the turn, applies conservative prompt fallback extraction, applies prompt-driven forgets, and trims low-priority short-term memory. Recall uses priority cutoffs: normal mode recalls priority `0..3`, thinking mode recalls priority `0..10`, and simple greetings recall only priority `0`.

Marifold also reads legacy Markdown memory files in `memories/user.md`, `memories/preferences.md`, `memories/notes.md`, and `memories/auto_short.md` as read-only fallback prompt context.

## Relationship to priest-typescript

Marifold depends on `@priest-ai/core` for provider calls, streaming, context assembly, and SQLite-backed session continuity.

Marifold owns only the product-level wrapper: CLI commands, Marifold config, priests-style profile directory loading, profile memory selection, and user-facing runtime behavior.
