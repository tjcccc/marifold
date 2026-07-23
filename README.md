# Marifold

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

The primary surface is the **TUI** — an Ink/React terminal app launched by bare `marifold`. It's agent-first (with a `/chat` mode), rendering chat and agent-event streams with `/` commands, `$skill` invocation, an approval modal, `/btw` mid-run steering, a skills manager, a profile-aware header, and session resume (`--resume`). Skills (`marifold.skill.v0`, run via `$name`) execute as agentic tools: the skill body is authoritative instructions and, in agent mode, the model reads the skill's own bundled files (e.g. a `vars.toml`) to do its work. `marifold init` and `marifold provider add` walk you through choosing a provider/model interactively.

Underneath sits an approval-aware agent loop with native provider tool calling (through `@priest-ai/core` 2.4) and a control-block fallback, narrow built-in tools (file read/write, shell, web search, profile delegation), a workspace write boundary, config-driven approval policy, a `marifold agent` command, chat `/search`/`/read`/`/image`, ChatGPT/Copilot OAuth, the `marifold.skillapp.v0` schema spec, and cron-scheduled unattended runs hosted inside `marifold service` — alongside priests-style profile chat, structured per-profile memory, model/provider management, config backup/import, the loopback-only Fastify service API, and ephemeral task-state storage.

For product direction and future scope, see [docs/vision.md](docs/vision.md) and [docs/roadmap.md](docs/roadmap.md). For the terminal app, see [docs/tui.md](docs/tui.md).

## What Marifold Supports

- Onboarding: `marifold init` writes config and interactively picks a provider/model (so a first run never points at a model you don't have); `marifold provider add` configures a provider (including pointing Ollama at a remote/Tailscale server); running `marifold` before `init` prints a clear hint instead of failing.
- Session resume: `marifold --resume` (most recent) or `--resume <id>` replays the conversation; the in-TUI `/resume` picker resumes too (`/session` remains an alias). Agent/skill runs persist one clean turn (your invocation → the final answer).
- Skills as agentic tools: `$name [args]` runs a skill; the skill body is authoritative instructions and, in agent mode, the model reads the skill's bundled files (e.g. `vars.toml` for `#name` fragments) via `read_file`. A skill's run mode follows the session unless it declares `mode:`.
- Built-in skill-management guidance: ordinary agent prompts that mention skills receive the active profile and configured global skill paths, so TUI, CLI, service, and Web UI agent runs update Marifold skills instead of creating another tool's skill directory in the workspace.
- The TUI: launch with bare `marifold` (or `marifold --profile <name>`); agent mode by default, `/chat` for chat.
- Input grammar: plain text → agent/chat, `/command` → app-executed action, `$skill [args]` → model-backed skill.
- `/` commands: `/help` `/exit` `/new` `/agent` `/chat` `/model` `/profile` `/resume` `/think` `/clear` `/stop` `/btw` `/permissions` `/skills` `/install-skill` `/doctor`, plus `/read` `/image` `/attach-original` `/remember` `/forget` `/delete-memory`.
- Approval modal that previews the tool's input (file content / shell command), with allow-once / session-grant / persist-to-config / deny; escalated (out-of-cwd) calls always prompt; `/permissions` shows modes and grants.
- `/btw <text>` steers a running task without cancelling it; Esc / Ctrl+C cancels a run, and a second Ctrl+C when idle exits.
- Input editing: history (Up/Down), multi-line via trailing `\`, readline keys (Ctrl+A/E/U/W), and Tab completion for `/commands` and `$skills`.
- `marifold.skill.v0` skills run via `$name [args]` (inline prompting for missing variables), managed with `/skills` (Enter run, Del remove) and `/install-skill <path|url>`; bundled examples in `examples/skills/`.
- A launch-time profile picker when no default profile resolves.
- The launch directory is the workspace; `~/.marifold` stays config/state; profiles are identities, not workspaces.
- Non-TTY invocation falls back with a hint instead of starting Ink.

## Core capabilities (pre-TUI foundation)

- Scheduled agent runs: `marifold schedule add --cron "0 9 * * 1-5" "<objective>"` plus `list`/`show`/`enable`/`disable`/`rm`/`run`.
- A scheduler hosted inside `marifold service` (minute resolution); schedules fire only while the service runs, and a firing missed during downtime fires once on the next tick.
- Unattended approval policy for scheduled runs: `ask` degrades to deny, with explicit `[agent.unattended]` overrides (e.g. `write = "allow"`).
- Read-only `/v1/schedules` service routes, `scheduled` task tags, and a `lastResultSeen` flag for future unread-result surfacing.
- The `marifold.skillapp.v0` SkillApp schema spec ([docs/skillapp.md](docs/skillapp.md)) with a TOML parser/validator in core (spec only — no runtime yet).
- Web search through the chat `/search <query>` command (DuckDuckGo by default, pluggable backend) with results injected as turn-local context.
- Model-initiated `web_search` and `read_file` tools on chat turns when `[web_search].enabled = true`, using a bounded tool loop.
- File attachment through chat `/read <path>` (100k-char truncation) and image attachment through `/image <path>` / `/image clear` and `ask --image <path>`. Local/base64 images are validated, MIME-corrected, metadata-stripped, and optimized before provider requests (1600 px maximum long edge; lossless WebP for PNG/transparent inputs; conservative high-quality encoding for JPEG and oversized static WebP inputs; animated images preserved). The candidate is used only when smaller. TUI and Web UI support one-turn `/attach-original <prompt>` to preserve original encoded bytes. Embedded/URL images are retained as display-only session attachments so the Web UI can restore transcript thumbnails without adding them to later model context.
- Base64/URL image payloads on the service `/v1/ask` route.
- ChatGPT OAuth token refresh before provider requests, mirroring the GitHub Copilot refresh flow.
- Approval-aware basic agent loop through `marifold agent "<objective>"`.
- Agent phases: model-generated plan, tool loop, verification, and task summary, all persisted as ephemeral task state.
- Native provider tool calling via `@priest-ai/core` 2.4 for Ollama, OpenAI-compatible (including the GitHub Copilot Responses API path), and Anthropic providers.
- Automatic control-block tool fallback (`<tool_call>` prompt blocks) for models without native tool support, plus `--tool-mode auto|native|control-block`.
- Built-in agent tools: `read_file`, `write_file`, `shell_exec`, and `ask_profile` (one-shot delegation to another profile/model).
- Per-profile approval policy per tool kind (`allow`/`ask`/`deny`), overriding a global `[agent]` default, with an Allow-once / Trust / Deny prompt, `--yes`, and unattended ask-degrades-to-deny behavior.
- Workspace write boundary: writes outside the run's working directory require interactive approval, except inside a profile's `agent.trusted_folders` allowlist (added via `/trust-folder` or the prompt's "Trust").
- Agent runs bypass profile memory: hidden memory control blocks are stripped and discarded, and task state is never promoted into profile memory.
- Provider-backed agent eval through `pnpm agent-eval -- --provider ollama --model qwen3.5:9b`.
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
- Loopback-only local HTTP service through `marifold service`, with optional bearer-token auth and a CORS origin allowlist (`[service]`).
- Service routes for health/status, sanitized config, providers, models, profiles, memories, sessions, ask, streaming chat, and live agent runs (SSE `AgentEvent` stream + approval/steer/cancel) — see [docs/service-api.md](docs/service-api.md).
- Server-sent event streaming for chat chunks through `/v1/chat/stream`.
- Ephemeral task-state storage under `[paths].tasks_dir`, defaulting to `~/.marifold/tasks`.
- Task API routes for objective, status, plan, events, summary, next action, and profile/session references.
- Automated CLI command smoke checks through `pnpm command-test`.
- Provider-backed memory eval script through `pnpm memory-eval -- --provider ollama --model gemma4:e4b`.
- SQLite session continuity through `@priest-ai/core`.
- A thin Marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

Marifold does not yet include semantic/vector retrieval, memory encryption, global-config editing screens in the Web UI (per-profile settings are editable; the SYSTEM screens — models & providers, default permissions, appearance — are the next milestone), SkillApp runtime/rendering, Workflow, Apple apps, external-agent aliases, provider-owned model deletion, remote (non-loopback) service binding, or service daemon packaging (schedules fire only while `marifold service` runs).

Web search uses DuckDuckGo scraping by default, which requires no API key but can be blocked by DuckDuckGo's anomaly detection on some networks. Errors surface clearly in `/search` output and tool results, and the `SearchBackend` interface is pluggable for alternative engines.

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

This writes `~/.marifold/config.toml`, creates `~/.marifold/profiles/default`, and keeps existing profile files if you re-run with `--force`. On a terminal it then **interactively picks your provider and model** (and offers an optional web-search toggle), so the default model is one you actually have. Pass `--model <name>` (or run non-interactively) to skip the picker.

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

For CLI smoke checks that avoid live model calls, see [docs/smoke.md](docs/smoke.md). For provider-backed checks after `pnpm build`, run:

```bash
pnpm memory-eval -- --provider ollama --model gemma4:e4b --suite professional
pnpm agent-eval -- --provider ollama --model qwen3.5:9b
```

The agent eval runs scripted objectives in sandboxed temp directories and reports which provider/model/tool-mode combinations converge — useful for deciding which saved models are agent-capable.

## Commands

Run the local CLI from the workspace:

```bash
pnpm marifold agent "Read package.json and summarize the scripts."
pnpm marifold agent --profile coder --max-iterations 10 "Count the .md files in this directory."
pnpm marifold agent --tool-mode control-block --yes "Write a haiku into haiku.txt"

pnpm marifold ask "Hello"
pnpm marifold ask --profile default "Explain Marifold in one sentence."
pnpm marifold ask --no-memories "Format this JSON"
pnpm marifold ask --think true "Solve step by step."
pnpm marifold ask --image ./photo.jpg "What is in this image?"

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
pnpm marifold config set service.web_dir ./apps/web/dist
pnpm marifold config get service.web_dir
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

pnpm marifold schedule add --cron "0 9 * * 1-5" --name digest "Summarize my notes folder."
pnpm marifold schedule list
pnpm marifold schedule show sched_xxxx
pnpm marifold schedule disable sched_xxxx
pnpm marifold schedule run sched_xxxx
pnpm marifold schedule rm sched_xxxx

pnpm marifold service
pnpm marifold service --host 127.0.0.1 --port 32140
```

The packaged binary name is `marifold`.

Inside `marifold chat`, use `/help` for chat commands. End a line with `\` to continue a multiline message.

Memory commands available inside chat:

```text
/think on             Enable thinking mode for supported providers.
/think off            Disable thinking mode.
/search <query>        Search the web and answer using the results.
/read <path>           Attach a local file's content to your next message.
/image <path>          Attach an image to your next message. Repeatable.
/image clear           Drop pending image attachments.
/attach-original <q>   Send attached images unchanged for this message only (TUI/Web UI).
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
timeout_seconds = 300
think = false
max_context_tokens = 16000
# session_context_turns = "all"   # "all" | 0 | 5 | 10 — recent turns the model sees per turn

[models]
options = [
  "ollama/gemma4:e4b",
]

[memory]
size_limit = 50000
context_limit = 2400

[agent]
max_iterations = 20
tool_output_limit = 100000
tool_mode = "auto"

[agent.approval]
read = "allow"
write = "ask"
shell = "ask"
network = "ask"
delegate = "allow"

[web_search]
enabled = false
max_results = 5

[paths]
profiles_dir = "~/.marifold/profiles"
sessions_db = "~/.marifold/sessions.db"
tasks_dir = "~/.marifold/tasks"
schedules_dir = "~/.marifold/schedules"

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

`marifold service` starts a Fastify HTTP service bound to `127.0.0.1:32140` by default. It intentionally accepts loopback hosts only. The API surface is `/health` and `/v1/*` routes for app clients: sanitized config/provider/model views, profiles, memories, sessions, ask/chat, SSE streaming chat, task state, read-only schedules, live agent runs (`POST /v1/runs`, a resumable SSE `AgentEvent` stream, and approval/steer/cancel routes), and config-editing writes (`PATCH /v1/config` with CLI `config set` parity, per-profile settings/files/trusted-folders/memory-forget routes). The full wire contract is documented in [docs/service-api.md](docs/service-api.md).

The optional `[service]` section configures API access for browser clients:

```toml
[service]
token_env = "MARIFOLD_SERVICE_TOKEN"     # bearer token clients must send (preferred over inline `token`)
cors_origins = ["http://localhost:5173"] # exact-match browser origins allowed to call the API
```

With no token resolved, auth is off (bare loopback, the historic default); with no `cors_origins`, cross-origin browser requests are rejected. `marifold service --token/--token-env/--cors-origin` override the config per start. Auth covers `/v1/*`; `/health` and hosted static files stay reachable.

### Service token workflow

The bearer token is an optional, user-chosen shared secret for Marifold's
`/v1/*` API. It is not a model-provider token, Marifold does not issue one,
and the API intentionally never reveals its value.

On the machine that runs the service, generate a strong token and keep it in
the environment used to start Marifold:

```sh
openssl rand -hex 32
export MARIFOLD_SERVICE_TOKEN='paste-the-generated-value'
marifold config set service.token_env MARIFOLD_SERVICE_TOKEN
marifold service
```

The `export` above lasts only for that shell. For a persistent service, define
the variable in its service manager or another appropriate local secret store.
In the Web UI, open **Connection** from the sidebar and enter the same value in
**Bearer token**. Leave **Service URL** empty when the Web UI is served by that
service; the token is stored in that browser's local storage and sent as the
`Authorization: Bearer …` header.

The token authenticates requests but does not make Marifold remotely
reachable. The service remains loopback-only. For office-to-home access, keep
the home service on loopback and create an authenticated tunnel from the office
machine:

```sh
ssh -L 32140:127.0.0.1:32140 user@home-host
```

Then open `http://127.0.0.1:32140` locally and enter the host's token if one is
configured. Do not expose port 32140 directly to the public internet. See
[Service API authentication](docs/service-api.md#authentication) for the full
security behavior.

## Web UI

`apps/web` is the browser client (Vite + React, see [apps/web/README.md](apps/web/README.md)): the Agent screen renders chat and live agent runs — plan, tool activity, the approval sheet (Allow once / Always allow / Trust folder / Deny), mid-run steering, cancel, catch-up replay, response/code copying, image galleries, durable session rename/pin/delete actions, and history-aware prompt editing that regenerates the selected exchange in place without deleting later turns — plus an editable per-profile Config screen (mode, model override, memories/thinking, permissions with inherited-vs-overridden and inherit-reset, trusted folders, PROFILE/RULES/CUSTOM editors, memory Forget/Delete) and light/dark marigold theming from the committed design concept.

```sh
pnpm --filter @marifold/web build
marifold service --web-dir apps/web/dist   # serves the app at http://127.0.0.1:32140
```

For development: `marifold service --cors-origin http://localhost:5173` + `pnpm --filter @marifold/web dev`. Set `[service].web_dir` in config.toml to host it permanently.

`marifold config export <file>` writes config, profile files, memory files, and optional sessions into a local JSON backup. Treat backups as sensitive if your config contains saved `api_key` or `oauth_token` values.

`marifold model add` stores provider/model choices in `[models].options`. With no arguments it starts an interactive provider picker, prompts for OAuth/manual credentials for OAuth providers such as GitHub Copilot and ChatGPT when no usable credential exists, then shows live provider models when Marifold can list them. Saved credentials use local `[providers.<name>]` fields such as `api_key`, `oauth_token`, and `api_key_expires_at`; existing `api_key_env` configs still work and environment variables take precedence at runtime. The positional `marifold model add <provider> <model>` form remains available for scripts. `marifold provider <name> list` asks the provider for live model names when Marifold knows how to query that provider type.

For GitHub Copilot, Marifold offers models compatible with the current chat adapters. Models such as `gpt-5.4` use `/chat/completions`; responses-only models such as `gpt-5.4-mini` use `/responses`.

For GitHub Copilot OAuth, Marifold refreshes the short-lived Copilot IDE token from the saved `oauth_token` before provider requests when the saved token is expired or close to expiry. Pasted Copilot IDE tokens without an `oauth_token` cannot be refreshed automatically.

`marifold model rm <provider/model>` removes a saved model option from Marifold config. It does not delete provider-owned model files, pull caches, or remote model access.

`marifold model validate` validates the default or profile-resolved provider/model. It checks configured provider access and uses live model lists for Ollama and OpenAI-compatible providers when reachable. `marifold model validate --all` validates every saved model option plus global and profile-specific defaults.

`marifold model default` starts an interactive selector over added models and includes `Add new model...`, which runs the same provider/model setup flow as `marifold model add` before setting the global default. `marifold model default --profile <name>` starts a profile selector with `Use default (<global provider/model>)`, saved models, and `Add new model...`; choosing `Use default` clears the profile override so new sessions for that profile use the global default.

`[memory].context_limit` caps the combined memory text injected into one provider request. Set it to `0` for unlimited memory injection. `[memory].size_limit` caps `memories/auto_short.jsonl`; low-priority short-term entries are trimmed first while priority `0` entries are preserved where possible.

`[default].think` controls default thinking mode. Thinking is passed as provider option `think` only to providers known to support it: Ollama-compatible providers plus `bailian` and `alibaba_cloud`.

`[default]` also holds the conversation-context controls. `max_context_tokens` (budget that triggers summary compaction near ~80%; `0` disables it) and `session_context_turns` (hard cap on recent turns the model sees each turn — `"all"`/absent means no cap) are inherited by profiles and overridable per-profile in `profile.toml`. `compaction_keep_turns` (recent turns kept verbatim when compacting; defaults to 6) is global-only. See the `profile.toml` properties table below for the per-profile form.

The `[web_search]` section is optional. `enabled = true` lets the model call `web_search` (and `read_file`, when read policy is `allow`) during chat turns through a bounded tool loop; the explicit `/search` command works regardless of this flag. Intermediate tool turns are turn-local — sessions store only your prompt and the final answer, and memory updates apply only from the final response.

For ChatGPT OAuth (`marifold model add chatgpt`), Marifold refreshes the expired API credential from the saved refresh token before provider requests, persisting the rotated refresh token — matching the GitHub Copilot refresh behavior.

The `[agent]` section is optional; defaults apply when it is absent. `[agent.approval]` sets per-tool-kind policy (`allow`, `ask`, or `deny`) for `read`, `write`, `shell`, `network`, and `delegate` tools. In interactive runs, `ask` prompts; in unattended runs (no approval handler), `ask` degrades to deny. `tool_mode = "auto"` uses native provider tool calling and falls back to prompt control blocks when the provider rejects tools.

The whole `[agent]` table (approval, `unattended`, `trusted_folders`, `max_iterations`, `tool_mode`) is **per-profile overridable** in `profile.toml` — a profile's keys merge over the global `[agent]`, so e.g. a `computer_helper` profile can set `agent.approval.shell = "allow"` while a `writing_helper` stays restricted. The interactive approval prompt is **Allow once / Trust (and allow always) / Deny** — "Trust" persists to the active profile (`agent.approval.<kind> = "allow"`, or, for a write outside the workspace, the folder into `agent.trusted_folders`).

Writes outside the run's working directory escalate to an interactive prompt even when `write = "allow"` — **unless** the target is inside an `agent.trusted_folders` entry (a flat allowlist of folders where writes are allowed without prompting; add with `/trust-folder <path>` or the prompt's "Trust" button). This is what lets an unattended/scheduled profile write outside the project (e.g. a daily blog to `~/my_docs/blog`). Sensitive roots (`~`, `/`, `~/.ssh`, `~/.marifold`) are refused.

## Agent

`marifold agent "<objective>"` runs a basic agent loop: the model produces a short plan, iterates with tools (file read/write, shell, profile delegation), verifies the outcome against the objective, and writes a summary. Progress persists as ephemeral task state under `[paths].tasks_dir` — inspectable via the task service routes — and is never promoted into profile memory.

The `ask_profile` tool lets the agent delegate a one-shot subtask to another profile (and that profile's provider/model), which is Marifold's minimal form of multi-model orchestration. Delegated requests are plain asks without tools, so delegation depth is structurally one.

Cancel a run with Ctrl+C; the task is marked `cancelled`. Runs stopped at the iteration cap are marked `failed`, and runs whose verification does not confirm the objective are marked `blocked` with a suggested next action.

## Schedules

`marifold schedule add --cron "<expression>" "<objective>"` stores a schedule under `[paths].schedules_dir`. Schedules fire **only while `marifold service` is running** (minute resolution); a firing missed during downtime fires once on the next tick. Each firing runs the agent unattended: `ask`-mode tools are denied unless `[agent.unattended]` explicitly allows that tool kind:

```toml
[agent.unattended]
write = "allow"
```

Each run creates a task tagged `scheduled` and records `lastTaskId`/`lastResultSeen` on the schedule for later inspection (`marifold schedule show`, `/v1/schedules`, `/v1/tasks`). `marifold schedule run <id>` executes one firing immediately, also unattended.

## Profiles

Marifold loads priests-style profile directories:

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

### `profile.toml` properties

All keys are optional. An absent key inherits the global `[default]` value (where one exists), then the built-in default — so an empty `profile.toml` behaves exactly like the defaults.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `provider` | string | inherits `[default].provider` | Provider override. Must be set **together with** `model` (both or neither). |
| `model` | string | inherits `[default].model` | Model override. Must be set together with `provider`. |
| `memories` | boolean | `true` | Load profile memory for this profile. Set `false` for tool profiles. Per-run `--no-memories` disables it for one `ask`/`chat`. |
| `mode` | `"agent"` \| `"chat"` | `"agent"` | Default TUI interaction mode for this profile. |
| `max_context_tokens` | integer | inherits `[default].max_context_tokens` | Conversation-context budget in tokens; near ~80% older turns fold into a running summary. `0` disables compaction. |
| `session_context_turns` | integer ≥ 0 \| `"all"` | `"all"` (inherits `[default].session_context_turns`) | Hard cap on the recent session turns the model sees each turn — applies to chat replay and non-lean agent history. `0` = none; `"all"` or absent = no cap. Older turns stay on disk; this only bounds what is sent per turn. Pairs with `max_context_tokens` (the budget safety net). |
| `think` | boolean | inherits `[default].think` (off) | Per-profile thinking default. Toggle per session with `/think on\|off`. |
| `agent.approval.<kind>` | `"allow"` \| `"ask"` \| `"deny"` | inherits global `[agent.approval]` | Per-profile tool permission for `read`/`write`/`shell`/`network`/`delegate`. Persisted by the approval prompt's "Trust". |
| `agent.trusted_folders` | array of paths | `[]` (union of global) | Folders where this profile may write without prompting (a flat allowlist). Add with `/trust-folder` or the prompt. The whole `[agent]` table (incl. `max_iterations`, `tool_mode`, `unattended`) is per-profile overridable. |

Example:

```toml
provider = "bailian"
model = "qwen3.6-plus"
mode = "chat"
session_context_turns = 5
```

`memories/user.jsonl` stores durable user facts, `memories/preferences.jsonl` stores durable preferences, and `memories/auto_short.jsonl` stores short-term notes. Each JSONL entry stores rich metadata such as `priority`, `confidence`, `stability`, `source`, `source_type`, `scope`, timestamps, optional `evidence`, optional `reason`, optional `conflict_key`, and supersession status.

Memory is context, not authority. Human-authored profile files and the current user message outrank memory. Prompt injection receives compact grouped memory blocks rather than raw JSON.

Marifold creates memory files for existing profiles when memory is first prepared, read, or written. When memory is on, Marifold asks the model to emit hidden memory control blocks for useful saves or forgets, strips those blocks from visible replies and session history, applies JSONL updates after the turn, applies conservative prompt fallback extraction, applies prompt-driven forgets, and trims low-priority short-term memory. Recall uses priority cutoffs: normal mode recalls priority `0..3`, thinking mode recalls priority `0..10`, and simple greetings recall only priority `0`.

Marifold also reads legacy Markdown memory files in `memories/user.md`, `memories/preferences.md`, `memories/notes.md`, and `memories/auto_short.md` as read-only fallback prompt context.

## Relationship to priest-typescript

Marifold depends on `@priest-ai/core` for provider calls, streaming, native tool-call transport, context assembly, and SQLite-backed session continuity. Priest owns everything about talking to models; Marifold owns everything about acting on the world.

Marifold owns the product-level layer: CLI commands, Marifold config, priests-style profile directory loading, profile memory selection, concrete agent tools, approval policy, task state, and user-facing runtime behavior.
