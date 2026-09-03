# marifold

marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

The primary surface is the **TUI** — an Ink/React terminal app launched by bare `marifold`. Every ordinary message runs through one approval-aware Agent path: the model answers directly when no action is needed and chooses tools when work is required. The TUI renders `/` commands, `$skill` invocation, approval prompts, `/btw` mid-run steering, a skills manager, a profile-aware header, and session resume (`--resume`). Skills (`marifold.skill.v0`, run via `$name`) execute as agentic tools: the skill body is authoritative instructions and the model can read the skill's own bundled files (e.g. a `vars.toml`) when needed. `marifold init` and `marifold provider add` walk you through choosing a provider/model interactively.

Underneath sits an approval-aware agent loop with native provider tool calling, provider-hosted search, and Responses reasoning continuity (through `@priest-ai/core` 3.x) plus control-block and Marifold web-search fallbacks, narrow built-in tools (file read/write, isolated shell, per-run Python packages, web search, profile delegation), capability-scoped run workspaces, config-driven approval policy, a `marifold agent` command, conversation file/image attachments, ChatGPT/Copilot OAuth, the model-driven `marifold.skillapp.v1`/`.v2` template contracts (with legacy App v0 compatibility), and cron-scheduled unattended runs hosted inside `marifold service` — alongside lightweight profile conversations, structured per-profile memory, model/provider management, config backup/import, the default-loopback Fastify service API with private LAN/Tailscale access for the owner's devices, and ephemeral task-state storage.

For product direction and future scope, see [docs/vision.md](docs/vision.md) and [docs/roadmap.md](docs/roadmap.md). For the terminal app, see [docs/tui.md](docs/tui.md).

## What marifold Supports

- Onboarding: `marifold init` writes config and interactively picks a provider/model (so a first run never points at a model you don't have); `marifold provider add` configures a provider (including pointing Ollama at a remote/Tailscale server); running `marifold` before `init` prints a clear hint instead of failing.
- Session resume: `marifold --resume` (most recent) or `--resume <id>` replays the conversation; the in-TUI `/resume` picker resumes too (`/session` remains an alias). Agent/skill runs persist one clean turn (your invocation → the final answer, or a clear failed/cancelled outcome when no final answer was produced).
- Skills as agentic tools: `$name [args]` resolves the selected profile/global skill or a protected built-in directly, expands its variables, and runs its authoritative instructions without leaking earlier skill-turn history. The original `$name …` invocation remains in durable history. Bundled files (e.g. `vars.toml` for `#name` fragments) are available through `read_file`; Skills default to Agent execution, while an explicit legacy `mode: chat` declaration still uses the retained compatibility transport.
- Protected skill management: `$skill-installer install|update|remove|uninstall|help` manages local skill sources and `$skill-creator` gathers requirements and creates a validated skill. Both default to the shared user scope so new profiles see installed Skills immediately; `--profile <name>` creates or changes a profile-only copy. The older `--global`/`-g` spelling remains accepted as a redundant compatibility alias. Their names are compiled into core, cannot be shadowed or removed, and ordinary skill-related prompts receive the same validated management guidance lazily.
- The TUI: launch with bare `marifold` (or `marifold --profile <name>`); ordinary messages always use the Agent path.
- Input grammar: plain text → agent, `/command` → app-executed action, `$skill [args]` → model-backed skill.
- `/` commands: `/help` `/exit` `/new` `/model` `/profile` `/resume` `/think` `/clear` `/stop` `/btw` `/permissions` `/skills` `/install-skill` `/doctor [--fix]`, plus `/read` `/image` `/attach-original` `/remember` `/forget` `/delete-memory`.
- Approval modal that previews the tool's input (file content / shell command), with allow-once / session-grant / persist-to-config / deny; escalated (out-of-cwd) calls always prompt; `/permissions` shows modes and grants.
- `/btw <text>` steers a running task without cancelling it; Esc / Ctrl+C cancels a run, and a second Ctrl+C when idle exits.
- Input editing: history (Up/Down), multi-line via trailing `\`, readline keys (Ctrl+A/E/U/W), and Tab completion for `/commands` and `$skills`.
- `marifold.skill.v0` skills run via `$name [args]` (inline prompting for missing variables), managed globally with `/skills` (Enter run, Del remove) and `/install-skill <path|url>`; add `--profile <name>` for a profile-only copy. Bundled examples live in `examples/skills/`.
- A launch-time profile picker when no default profile resolves.
- The Web UI presents profiles as a compact contact list: 40 px avatars, the latest response preview and relative activity time, recent-activity sorting, persistent pinning, and a row menu that opens profile Config. Stored profiles can be removed from Config after changing the default profile and typing the profile name in a second confirmation dialog; their conversation history is retained.
- The launch directory is the workspace; `~/.marifold` stays config/state; profiles are identities, not workspaces.
- Non-TTY invocation falls back with a hint instead of starting Ink.

## Core capabilities (pre-TUI foundation)

- Scheduled agent runs: `marifold schedule add --cron "0 9 * * 1-5" "<objective>"` plus `list`/`show`/`enable`/`disable`/`rm`/`run`.
- A scheduler hosted inside `marifold service` (minute resolution); schedules fire only while the service runs, and a firing missed during downtime fires once on the next tick.
- Unattended approval policy for scheduled runs: `ask` degrades to deny, with explicit `[agent.unattended]` overrides (e.g. `write = "allow"`).
- Read-only `/v1/schedules` service routes, `scheduled` task tags, and a `lastResultSeen` flag for future unread-result surfacing.
- Model-driven SkillApps ([docs/app.md](docs/app.md)): restricted, statically compiled `~/.marifold/apps/<name>/skillapp.ts` templates, app-local or profile-installed Skills, explicit or profile-inherited models, semantic form, attachment, Markdown-preview, and text-download components, static fail-closed read permissions, service-owned state, debounced latest triggers, structured results, and bookmarkable `/apps/<name>` views with an Activity drawer. A protected built-in `skillapp-builder` turns rough ideas into validated bundles through resumable questions, approve-once atomic installation, and live catalog refresh without a service restart.
- Autonomous fallback web search through a provider-pluggable model tool, with DuckDuckGo as the keyless default.
- Native-first web search: OpenAI API, ChatGPT subscription, xAI/Grok, and verified Bailian/Alibaba Cloud model families use provider-hosted search independently of `[web_search].enabled`. Bailian selects either its Responses tool or Chat Completions `enable_search` contract per model; unknown models use Marifold's fallback unless `[providers.<name>].native_web_search` overrides the transport. If a native route rejects search before producing output, Marifold retries once through the configured fallback. Runs with neither capability tell the model that search is unavailable. `read_file` remains a caller-executed chat tool when the fallback section is enabled.
- File attachment through TUI `/read <path>` (100k-char truncation), image attachment through `/image <path>` / `/image clear`, and one-shot `ask --image <path>`. Local/base64 images are validated, MIME-corrected, metadata-stripped, and optimized before provider requests (1600 px maximum long edge; lossless WebP for PNG/transparent inputs; conservative high-quality encoding for JPEG and oversized static WebP inputs; animated images preserved). The candidate is used only when smaller. TUI and Web UI support one-turn `/attach-original <prompt>` to preserve original encoded bytes. Embedded/URL images are retained as display-only session attachments so the Web UI can restore transcript thumbnails without adding them to later model context. The Web composer extracts a bounded readable view from modern Word (`.docx`), Excel (`.xlsx`), and PowerPoint (`.pptx`) files and accepts PDFs, ebooks, archives, and other bounded binaries for agent runs. Every Agent upload is staged as an immutable local resource: `inspect_attachment` returns metadata, a read-only path, and at most an 8k-character preview; `read_attachment` and `search_attachment` expose bounded selections. Complete joins, conversions, edits, and extraction run locally against the original file, keeping the full document out of model context.
- Base64/URL image payloads on the service `/v1/ask` route.
- ChatGPT OAuth token refresh before provider requests, mirroring the GitHub Copilot refresh flow.
- Approval-aware basic agent loop through `marifold agent "<objective>"`.
- Agent execution: optional model-generated plan, approval-aware tool loop, focused checks through normal tools, and a task summary persisted as ephemeral task state. There is no separate model self-grading pass.
- Native provider tool calling via `@priest-ai/core` 3.x for Ollama, OpenAI-compatible Responses (including the GitHub Copilot path), and Anthropic providers, plus provider-executed web search on OpenAI API, ChatGPT subscription, xAI, and verified Bailian/Alibaba routes. Neutral reasoning configuration, safe provider summaries, opaque multi-turn reasoning continuity, and cached/reasoning token usage are preserved across chat and agent tool loops.
- Automatic control-block tool fallback (`<tool_call>` prompt blocks) for models without native tool support, plus `--tool-mode auto|native|control-block`.
- Built-in agent tools: attachment-scoped `inspect_attachment`, `read_attachment`, and `search_attachment`; `read_file`, `write_file`, isolated `shell_exec`, per-run `python_package_install`, `ask_profile` (one-shot delegation to another profile/model), and optional `ask_user` clarification checkpoints with single- or multi-select choices. The agent is instructed to ask only when essential information is missing; otherwise it proceeds with reasonable assumptions. Individual model-visible tool results are capped at 24k characters and accumulated tool context at 64k characters.
- Per-profile approval policy per tool kind (`allow`/`ask`/`deny`), overriding a global `[agent]` default, with an Allow-once / Trust / Deny prompt, `--yes`, and unattended ask-degrades-to-deny behavior.
- Capability-scoped run workspace: each run receives private `~/.marifold/runs/<run-id>/` runtime-state, input, work, output, temp, cache, and `.venv` directories; user-facing `~` and `$HOME` still mean the account home. Shell processes can read/write only the selected working folder, trusted folders, and the private run directories. The active profile and configured global skill directories are exposed as narrow read-only roots so skills can inspect their own bundled files without exposing other marifold state. There is no unrestricted fallback when a platform sandbox is unavailable.
- Agent runs bypass profile memory: hidden memory control blocks are stripped and discarded, and task state is never promoted into profile memory.
- Provider-backed agent eval through `pnpm agent-eval -- --provider ollama --model qwen3.5:9b`.
- marifold-branded CLI.
- One-shot request-response.
- Interactive chat.
- Chat session resume with `--resume` or `--resume last`.
- Workspace initialization.
- Unified per-profile instructions with read-compatible legacy profile loading.
- Basic profile creation and default-profile selection.
- Profile inspection.
- Basic provider/model configuration.
- Saved provider/model options through `[models].options`.
- Adding provider/model options from the CLI.
- Removing saved provider/model options from marifold config without deleting provider-owned model files.
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
- Explicit conversation memory commands for remember, soft-forget, and permanent delete.
- Profile memory inspection through `profile memory`.
- Memory injection through the `@priest-ai/core` request `memory` lane.
- Memory recall controls through `[memory].context_limit`, `profile.toml` `memories = false`, and `--no-memories`.
- Thinking controls through `[default].think`, `ask --think [true|false]`, and TUI `/think on|off`.
- Basic config, model, provider, and session inspection commands.
- Config backup and restore for config, profiles, memories, and optional sessions.
- Profile rename and delete commands for stored profiles.
- Profile-filtered session listing.
- Bulk session clearing with profile/date/keep-last filters.
- Default-loopback HTTP service through `marifold service`, with permanently source-filtered LAN/Tailscale access for the owner's devices, optional bearer authentication, and a CORS origin allowlist (`[service]`).
- Single-instance service lifecycle through foreground `marifold service` / `marifold service start`, background `marifold service start --daemon`, `marifold service restart`, `marifold status [--logs]`, and `marifold service stop`.
- Service routes for health/status, sanitized config, providers, models, profiles, memories, sessions, ask, streaming chat, and live agent runs (SSE `AgentEvent` stream + clarification/approval/steer/cancel) — see [docs/service-api.md](docs/service-api.md).
- Server-sent event streaming for safe reasoning summaries and answer chunks through `/v1/chat/stream`.
- Ephemeral task-state storage under `[paths].tasks_dir`, defaulting to `~/.marifold/tasks`.
- Task API routes for objective, status, plan, events, summary, next action, and profile/session references.
- Automated CLI command smoke checks through `pnpm command-test`.
- Provider-backed memory eval script through `pnpm memory-eval -- --provider ollama --model gemma4:e4b`.
- SQLite session continuity through `@priest-ai/core`, with marifold-owned durable response timing, model, token, reasoning, cache, and estimated-cost metadata for chat and agent exchanges.
- A thin marifold runtime wrapper around `@priest-ai/core`.

## Non-goals

marifold does not yet include semantic/vector retrieval, memory encryption, general effectful App actions beyond the protected SkillApp builder, advanced App components, Workflow, Apple apps, external-agent aliases, or provider-owned model deletion.

Marifold fallback search uses DuckDuckGo scraping by default, which requires no API key but can be blocked by DuckDuckGo's anomaly detection on some networks. Firecrawl provides AI-ready search/scraping, while the optional Ollama Cloud backend calls `ollama.com/api/web_search` with `OLLAMA_API_KEY`; despite its name, this is an external caller-executed service rather than a local Ollama model capability. Errors surface clearly in tool results and final responses, and the `SearchBackend` interface remains pluggable. Provider-hosted search is selected first when the active provider/model supports it and is unaffected by the fallback toggle.

## Setup

marifold requires Node.js 24 LTS. Install the published CLI globally; this one
package brings the TUI, service, and bundled Web UI:

```bash
npm install -g marifold
marifold init
```

Update an npm-installed copy to the package on npm's `latest` dist-tag:

```bash
marifold update
```

This is equivalent to `npm install --global marifold@latest`. Restart a running
service afterward so its background process uses the newly installed version.

Run `marifold` for the TUI, or start the service and open the Web UI at
`http://127.0.0.1:32140`:

```bash
marifold service start --daemon
```

For source development, the repository's `.nvmrc` pins the current LTS patch,
and `packageManager` pins the compatible pnpm release.

Install and build:

```bash
nvm use
pnpm install
pnpm build
```

After building or linking the source workspace, create local configuration:

```bash
marifold init
```

This writes `~/.marifold/config.toml`, creates `~/.marifold/profiles/default`, and keeps existing profile files if you re-run with `--force`. On a terminal it then **interactively picks your provider and model** (and offers an optional fallback-search toggle), so the default model is one you actually have. Pass `--model <name>` (or run non-interactively) to skip the picker.

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

Use the installed CLI directly. `pnpm` is reserved for source-workspace build and test commands:

```bash
marifold agent "Read package.json and summarize the scripts."
marifold agent --profile coder --max-iterations 10 "Count the .md files in this directory."
marifold agent --tool-mode control-block --yes "Write a haiku into haiku.txt"

marifold ask "Hello"
marifold ask --profile default "Explain marifold in one sentence."
marifold ask --no-memories "Format this JSON"
marifold ask --think true "Solve step by step."
marifold ask --image ./photo.jpg "What is in this image?"

marifold init
marifold init --provider openai --model gpt-4o-mini

marifold config show
marifold config set default.model gemma4:e4b
marifold config set service.web_dir ./apps/web/dist
marifold config get service.web_dir
marifold config export ./marifold-backup.json --include-sessions
marifold config import ./marifold-backup.json --force

marifold model
marifold model list
marifold model add
marifold model add ollama qwen3:8b
marifold model add openai gpt-4o-mini --base-url https://api.openai.com --api-key-env OPENAI_API_KEY --default
marifold model validate
marifold model validate --all
marifold model validate ollama/gemma4:e4b
marifold model validate gemma4:e4b --provider ollama
marifold model rm openai/gpt-4o-mini
marifold model default
marifold model default --profile coder
marifold model default gemma4:e4b
marifold model default qwen3:8b --provider ollama --profile coder
marifold model default --profile coder --clear

marifold provider
marifold provider list
marifold provider ollama list
marifold provider reauth xai
marifold provider status

marifold profile list
marifold profile show default
marifold profile memory default
marifold profile memory default --all --limit 100
marifold profile init coder
marifold profile rename coder writer
marifold profile delete writer --yes
marifold profile default coder
marifold doctor
marifold doctor --fix
marifold doctor --fix --profile writer

marifold session list --profile default
marifold session show test-session
marifold session rename test-session renamed-session
marifold session delete renamed-session
marifold session clear --profile default --keep-last 10 --yes

marifold schedule add --cron "0 9 * * 1-5" --name digest "Summarize my notes folder."
marifold schedule list
marifold schedule show sched_xxxx
marifold schedule disable sched_xxxx
marifold schedule run sched_xxxx
marifold schedule rm sched_xxxx

marifold service
marifold service start
marifold service start --daemon
marifold service start --daemon --verbose
marifold service restart
marifold status
marifold status --logs
marifold service stop
marifold service --host 127.0.0.1 --port 32140
marifold service --host 0.0.0.0

marifold update
```

Profile names are stable filesystem- and URL-safe identifiers: use ASCII
letters, numbers, underscores, and hyphens only (`[A-Za-z0-9_-]+`). Spaces and
other characters are rejected. Use the optional profile display name for a
human-readable label with spaces or Unicode.

The packaged binary name is `marifold`.

Related commands available inside the TUI:

```text
/think on             Enable thinking mode for supported providers.
/think off            Disable thinking mode.
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
marifold --config ./config.example.toml profile list
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
skills_dir = "~/.marifold/skills"
apps_dir = "~/.marifold/apps"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
```

Supported provider adapter types:

- `ollama`
- `openai-compatible`
- `anthropic`

The `model add` picker is seeded from the priests provider registry: Ollama, llama.cpp, LM Studio, Rapid-MLX, OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, Perplexity, Cohere, Together AI, Alibaba Bailian, Alibaba Cloud, MiniMax, Kimi, OpenRouter, GitHub Copilot OAuth, ChatGPT OpenAI OAuth, and custom OpenAI-compatible endpoints.

For `openai-compatible`, `base_url` may be the API root such as `https://api.openai.com`, or a versioned compatibility root such as `https://generativelanguage.googleapis.com/v1beta/openai`. marifold builds the final `/chat/completions`, `/responses`, and `/models` URLs from it.

`marifold init` accepts `--provider`, `--provider-type`, `--model`, `--base-url`, `--api-key-env`, `--profiles-dir`, `--sessions-db`, `--tasks-dir`, and `--force`. Non-Ollama providers require `--model`; custom OpenAI-compatible providers also require `--base-url`.

`marifold service` and `marifold service start` start the same foreground Fastify HTTP service, bound to `127.0.0.1:32140` by default. The npm package serves its bundled Web UI at that address automatically; `[service].web_dir` or `--web-dir` can replace it with another built directory. Startup prints the URL to open; a `--host 0.0.0.0` wildcard bind prints the current concrete IPv4 loopback, private-LAN, link-local, and Tailscale URLs instead of the unusable wildcard address. Technical details such as the raw bind address, Web UI directory, CORS allowlist, config path, and HTTP request-logging state are hidden unless `--verbose` is supplied. `marifold service start --daemon` runs it in the background and prints the same entry URLs and confirmed integration state before returning; `marifold service restart` gracefully replaces the running process in the same foreground or daemon mode and reuses its config path, host, port, working directory, logging, CORS origins, Web directory, and token source. `marifold status` reports the managed process, usable entry URLs, and its loopback/private access mode, `marifold status --logs` includes its latest 100 log lines, and `marifold service stop` performs a graceful stop. State and the daemon log live under `~/.marifold/service/`, and stale state is cleaned automatically. Only one managed service instance can run at a time, including foreground starts. Restart metadata never contains the bearer token: a configured token or token-environment name is resolved again, while a service originally started with raw `--token` requires `marifold service restart --token <token>`. A service already running from a version without restart metadata must be stopped and started once before it can be restarted. `--host 0.0.0.0` listens on every interface, but marifold always accepts only direct loopback, private LAN, link-local, IPv6 ULA, and Tailscale/CGNAT (`100.64.0.0/10`) peers; bearer authentication is optional and never widens that network boundary. A specific LAN or Tailscale bind address further narrows the interfaces exposed. Launch state from an older public-mode service is marked `legacy-public`; restarting it drops that obsolete mode and enforces private-network filtering. Ctrl+C/SIGTERM performs graceful cleanup and exits; shutdown is forced after five seconds or immediately on a second signal. A bind failure also closes the newly created runtime instead of leaving a background process alive. `--log` independently enables Fastify request logging: it prints in the foreground or is captured in the daemon log. The API surface is `/health` and `/v1/*` routes for app clients: sanitized config/provider/model views, profiles, memories, sessions, ask/chat, SSE streaming chat, task state, read-only schedules, live agent runs (`POST /v1/runs`, a resumable SSE `AgentEvent` stream, and clarification/approval/steer/cancel routes), and config-editing writes (`PATCH /v1/config` with CLI `config set` parity, per-profile settings/files/trusted-folders/memory-forget routes). The full wire contract is documented in [docs/service-api.md](docs/service-api.md).

The optional `[service]` section configures API access for browser clients:

```toml
[service]
token_env = "MARIFOLD_SERVICE_TOKEN"     # bearer token clients must send (preferred over inline `token`)
cors_origins = ["http://127.0.0.1:5173"] # exact-match browser origins allowed to call the API
```

With no token resolved, auth is off; loopback and private-network access remain available. With no `cors_origins`, cross-origin browser requests are rejected; a hosted Web UI reached through the same loopback, LAN, or Tailscale address is same-origin and needs no allowlist entry. `marifold service --token/--token-env/--cors-origin` override the config per start. When enabled, auth covers `/v1/*`; `/health` and hosted static files stay reachable. Authentication protects the API but never admits public source addresses.

### Service token workflow

The bearer token is an optional, user-chosen shared secret for marifold's
`/v1/*` API. It is not a model-provider token, marifold does not issue one,
and the API intentionally never reveals its value.

On the machine that runs the service, generate a strong token and keep it in
the environment used to start marifold:

```sh
openssl rand -hex 32
export MARIFOLD_SERVICE_TOKEN='paste-the-generated-value'
marifold config set service.token_env MARIFOLD_SERVICE_TOKEN
marifold service
```

The `export` above lasts only for that shell. A daemon started from that shell
inherits the variable, and `marifold service restart` reuses the configured
environment-variable name. A raw `--token` is never persisted and must be
supplied again to the restart command. For automatic restart after login or
reboot, define the variable in the external service manager or another
appropriate local secret store.

In the Web UI, open **Connection** from the sidebar, select **This server**, and
enter the same value in **Bearer token**. The token is stored for that named
server in the browser's local storage and sent as the
`Authorization: Bearer …` header.

For direct access over a trusted LAN or tailnet, start the service in private
mode; a token is optional:

```sh
marifold service --host 0.0.0.0
```

Then open `http://<service-host-ip>:32140`. The hosted Web UI and API are
already same-origin. If a token is configured, enter it in the Web UI
Connection sheet. Binding `0.0.0.0` opens the port on every active interface,
but marifold rejects source addresses outside its private ranges. Pass the
host's specific Tailscale or LAN address when narrower interface exposure is
desired.

Private mode uses the direct socket peer and deliberately ignores forwarded-IP
headers. Public reverse proxies and internet tunnels are unsupported because
they can hide the original peer from this boundary. Use a private LAN or an
encrypted private overlay such as Tailscale; add bearer authentication as
defense in depth. See
[Service API authentication](docs/service-api.md#authentication) for the full
security behavior.

Alternatively, keep using a locally hosted Web UI and point it at another
marifold service: open **Connection**, choose **Add server**, name it, and enter
the remote root URL (for example `http://<mac-mini-tailscale-ip>:32140`) plus
that server's bearer token. Switching entries remounts the workspace against
the selected service; profiles, sessions, routes, and drafts do not leak across
servers. Because this route is cross-origin, the remote service must include
the local Web UI's exact origin in `[service].cors_origins`, for example:

```toml
[service]
cors_origins = ["http://127.0.0.1:32140"]
```

Native macOS/iOS/iPadOS clients are not subject to browser CORS, but still use
the same service root and bearer token.

## Web UI

`apps/web` is the responsive browser client (Vite + React, see [apps/web/README.md](apps/web/README.md)): the Agent screen renders chat and live agent runs — plan, tool activity, the approval sheet (Allow once / Always allow / Trust folder / Deny), mid-run steering, cancel, catch-up replay, generated-file downloads, durable response time/token/cost footers, response/code copying, lazily loaded authenticated image galleries, local Office-file text extraction, scalable profile search, durable session rename/pin/archive/delete actions, server-backed session search, per-session drafts, and history-aware prompt editing that regenerates the selected exchange in place without deleting later turns. Generated-file buttons and model-authored `sandbox:` Markdown links both resolve through the same authenticated, same-run artifact API; Web never navigates directly to a model-supplied host path. Config edits profiles, providers, models, global agent defaults, web search, appearance, and the local service. The Providers column's `+` action opens the same ordered provider catalog as `marifold provider add`, applies its default server URL and API-key environment-variable name, and accepts no raw secret. Phone-sized browsers use full-width drill-down navigation for profiles, sessions, conversations, Apps, and Config while preserving the multi-pane desktop workspace at wider widths.

```sh
marifold service   # serves the bundled app at http://127.0.0.1:32140
```

For development: `marifold service --cors-origin http://127.0.0.1:5173` + `pnpm --filter @marifold/web dev`. Build with `pnpm --filter @marifold/web build`; `[service].web_dir` or `--web-dir` overrides the bundled production app.

`marifold config export <file>` writes config, profile files, memory files, and optional sessions into a local JSON backup. Treat backups as sensitive if your config contains saved `api_key` or `oauth_token` values.

`marifold model add` stores provider/model choices in `[models].options`. With no arguments it starts an interactive provider picker, prompts for OAuth/manual credentials for OAuth providers such as GitHub Copilot and ChatGPT when no usable credential exists, then shows live provider models when marifold can list them. The ChatGPT picker queries the signed-in account's Codex model catalog and offers its current list-visible, API-supported models; if that catalog cannot be reached, marifold falls back to its small known-model list and still permits a custom id. An expired saved access credential is not treated as usable, so setup can start a fresh sign-in when refresh fails. Saved credentials use local `[providers.<name>]` fields such as `api_key`, `oauth_token`, and `api_key_expires_at`; existing `api_key_env` configs still work and environment variables take precedence at runtime. The positional `marifold model add <provider> <model>` form remains available for scripts. `marifold provider <name> list` asks the provider for live model names when marifold knows how to query that provider type.

`marifold provider reauth <provider>` explicitly replaces saved credentials for the marifold-managed OAuth providers `github_copilot`, `chatgpt`, and `xai`. It preserves the provider's proxy and other transport configuration plus every saved model choice. Run it on the machine hosting marifold so browser/device callbacks return to the correct host.

For GitHub Copilot, marifold offers models compatible with the current chat adapters. Models such as `gpt-5.4` use `/chat/completions`; responses-only models such as `gpt-5.4-mini` use `/responses`.

For GitHub Copilot OAuth, marifold refreshes the short-lived Copilot IDE token from the saved `oauth_token` before provider requests when the saved token is expired or close to expiry. Pasted Copilot IDE tokens without an `oauth_token` cannot be refreshed automatically.

`marifold model rm <provider/model>` removes a saved model option from marifold config. It does not delete provider-owned model files, pull caches, or remote model access.

Web Config can remove a non-default provider after typed confirmation. Removal deletes that provider's local configuration, saved credentials, and marifold model options; it does not revoke a remote account or delete provider-owned models. Clear any profile model overrides that reference the provider first. OAuth provider pages expose **Re-authenticate…** with the exact host-local `marifold provider reauth <provider>` command.

`marifold model validate` validates the default or profile-resolved provider/model. It checks configured provider access and uses live model lists for Ollama and OpenAI-compatible providers when reachable. `marifold model validate --all` validates every saved model option plus global and profile-specific defaults.

`marifold model default` starts an interactive selector over added models and includes `Add new model...`, which runs the same provider/model setup flow as `marifold model add` before setting the global default. `marifold model default --profile <name>` starts a profile selector with `Use default (<global provider/model>)`, saved models, and `Add new model...`; choosing `Use default` clears the profile override so new sessions for that profile use the global default.

`[memory].context_limit` caps the combined memory text injected into one provider request. Set it to `0` for unlimited memory injection. `[memory].size_limit` caps `memories/auto_short.jsonl`; low-priority short-term entries are trimmed first while priority `0` entries are preserved where possible.

`[default].think` controls default thinking mode. marifold sends Priest's provider-neutral reasoning configuration to Ollama, Anthropic, ChatGPT, and Responses-only GitHub Copilot models. The legacy raw `think` option remains only for `bailian` and `alibaba_cloud`. When a provider returns a safe reasoning summary, marifold renders it separately from the answer; opaque provider continuation data is replayed to the provider but never exposed as text.

`[default]` also holds the conversation-context controls. `max_context_tokens` (budget that triggers summary compaction near ~80%; `0` disables it) and `session_context_turns` (hard cap on recent turns the model sees each turn — `"all"`/absent means no cap) are inherited by profiles and overridable per-profile in `profile.toml`. `compaction_keep_turns` (recent turns kept verbatim when compacting; defaults to 6) is global-only. See the `profile.toml` properties table below for the per-profile form.

The `[web_search]` section is optional and configures only Marifold's fallback search. Its `provider` may be `duckduckgo`, `firecrawl`, or `ollama`; Ollama Cloud requires `api_key_env = "OLLAMA_API_KEY"` (or an inline key) and sends search queries to ollama.com. OpenAI API, ChatGPT subscription, xAI/Grok, and verified Bailian/Alibaba model families try provider-hosted search first even when fallback `enabled = false`. Bailian auto mode uses Responses for documented newer Qwen/DeepSeek/GLM families, Chat Completions `enable_search` for documented Qwen chat families, and fallback for unknown model ids. Set `native_web_search = "responses"`, `"chat"`, or `"off"` under `[providers.bailian]` or `[providers.alibaba_cloud]` to override auto detection. If a native request rejects hosted search before emitting answer, reasoning, or tool output, Marifold retries that turn once with its fallback. It does not retry after partial provider output, which avoids duplicate answers. The fallback exposes Marifold's `web_search` tool (and `read_file`, when read policy is `allow`) through a bounded tool loop. When neither hosted nor fallback search is available, the model is explicitly instructed to say it cannot access web search instead of implying that it searched. The agent `network` policy can still disable both paths; unattended runs expose hosted search only when their effective network policy is `allow`. Provider-hosted search is part of the model request and does not emit Marifold's per-search approval event. Search remains model-initiated from natural-language requests; there is no manual `/search` command. Intermediate caller-tool turns are turn-local — sessions store only the prompt and the final answer, and memory updates apply only from the final response.

For ChatGPT OAuth (`marifold model add chatgpt`), marifold refreshes the expired API credential from the saved refresh token before provider requests, persisting the rotated refresh token — matching the GitHub Copilot refresh behavior. The ChatGPT subscription Codex backend rejects the public Responses `max_output_tokens` field, so marifold omits `[default].max_output_tokens` on that route while preserving it for providers that support it.

The `[agent]` section is optional; defaults apply when it is absent. `[agent.approval]` sets per-tool-kind policy (`allow`, `ask`, or `deny`) for `read`, `write`, `shell`, `network`, and `delegate` tools. In interactive runs, `ask` prompts; in unattended runs (no approval handler), `ask` degrades to deny. `tool_mode = "auto"` uses native provider tool calling and falls back to prompt control blocks when the provider rejects tools.

The whole `[agent]` table (approval, `unattended`, `trusted_folders`, `max_iterations`, `tool_mode`) is **per-profile overridable** in `profile.toml` — a profile's keys merge over the global `[agent]`, so e.g. a `computer_helper` profile can set `agent.approval.shell = "allow"` while a `writing_helper` stays restricted. The interactive approval prompt is **Allow once / Trust (and allow always) / Deny** when the requested capability is persistable. Calls involving external or sensitive host paths and package installation deliberately offer only one-time approval.

Writes outside the run's working directory escalate to an interactive prompt even when `write = "allow"` — **unless** the target is inside an `agent.trusted_folders` entry within the user's home (a flat allowlist added with `/trust-folder <path>` or the prompt's "Trust" button). Paths outside the user's home always require one-time approval—even with CLI `--yes`—and can never be persisted or silently used by unattended runs. Sensitive broad roots (`~`, `/`, `~/.marifold`) are never mounted as capabilities, and global/system runtime writes are refused.

Each agent run creates `~/.marifold/runs/<run-id>/` with isolated runtime-state, work/input/output/cache directories. In tool paths and shell commands, `~` and `$HOME` mean the real account home; the sandbox still denies broad home access and reopens only the working folder, trusted folders, narrow read-only roots, and private run directories. On macOS, `shell_exec` runs through Seatbelt with network disabled, host writes denied except for those explicit capabilities, and unrelated-process signals, Apple Events, clipboard, Launch Services mutation, and keychain services denied. Shell approval does not widen that boundary. Python commands use the run's `.venv`; package downloads must use `python_package_install`, which invokes `uv`, always asks once, and hides attachments/repositories from third-party build hooks while network is enabled. Direct global `pip`/Python-package writes remain blocked. Regular files written under `$MARIFOLD_OUTPUT_DIR` become opaque `artifact` events and authenticated Web downloads; symlinks and files over 512 MiB are never exposed. Run directories and recently finished download records are retained for up to 24 hours, subject to the bounded recent-run cap.

## Agent

`marifold agent "<objective>"` runs a basic agent loop: the model optionally produces a short plan, iterates with tools (file read/write, shell, profile delegation), performs focused observable checks through those same tools when the task needs them, and writes a summary. It does not make a separate self-grading model call. Progress persists as ephemeral task state under `[paths].tasks_dir` — inspectable via the task service routes — and is never promoted into profile memory.

The `ask_profile` tool lets the agent delegate a one-shot subtask to another profile (and that profile's provider/model), which is marifold's minimal form of multi-model orchestration. Delegated requests are plain asks without tools, so delegation depth is structurally one.

Cancel a run with Ctrl+C; the task is marked `cancelled`. Runs stopped at the iteration cap are marked `failed`. Tool denials and failed checks are returned to the model inside the normal loop so it can adapt or report the unresolved limitation.

## Schedules

`marifold schedule add --cron "<expression>" "<objective>"` stores a schedule under `[paths].schedules_dir`. Schedules fire **only while `marifold service` is running** (minute resolution); a firing missed during downtime fires once on the next tick. Each firing runs the agent unattended: `ask`-mode tools are denied unless `[agent.unattended]` explicitly allows that tool kind:

```toml
[agent.unattended]
write = "allow"
```

Each run creates a task tagged `scheduled` and records `lastTaskId`/`lastResultSeen` on the schedule for later inspection (`marifold schedule show`, `/v1/schedules`, `/v1/tasks`). `marifold schedule run <id>` executes one firing immediately, also unattended.

## Profiles

marifold loads lightweight profile directories:

```text
profiles/default/
  INSTRUCTIONS.md
  profile.toml
  memories/
    user.jsonl
    preferences.jsonl
    auto_short.jsonl
```

`INSTRUCTIONS.md` is one free-form Markdown document for the profile's identity,
behavior, tone, and optional context. Headings are organizational only; marifold
does not require or parse a section schema. Older `RULES.md`, `PROFILE.md`, and
`CUSTOM.md` files remain readable in their previous effective order. Run
`marifold doctor` to find them and `marifold doctor --fix` to back them up and
consolidate them into `INSTRUCTIONS.md`.

### `profile.toml` properties

All keys are optional. An absent key inherits the global `[default]` value (where one exists), then the built-in default — so an empty `profile.toml` behaves exactly like the defaults.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `display_name` | string | profile name | Optional human-readable label shown by clients. Blank or absent keeps the stable profile name as the display fallback. |
| `provider` | string | inherits `[default].provider` | Provider override. Must be set **together with** `model` (both or neither). |
| `model` | string | inherits `[default].model` | Model override. Must be set together with `provider`. |
| `memories` | boolean | `true` | Load profile memory for this profile. Set `false` for tool profiles. Per-run `--no-memories` disables it for one `ask`. |
| `max_context_tokens` | integer | inherits `[default].max_context_tokens` | Conversation-context budget in tokens; near ~80% older turns fold into a running summary. `0` disables compaction. |
| `session_context_turns` | integer ≥ 0 \| `"all"` | `"all"` (inherits `[default].session_context_turns`) | Hard cap on the recent session turns the model sees each turn — applies to conversation replay and non-lean agent history. `0` = none; `"all"` or absent = no cap. Older turns stay on disk; this only bounds what is sent per turn. Pairs with `max_context_tokens` (the budget safety net). |
| `think` | boolean | inherits `[default].think` (off) | Per-profile thinking default. Toggle per session with `/think on\|off`. |
| `agent.approval.<kind>` | `"allow"` \| `"ask"` \| `"deny"` | inherits global `[agent.approval]` | Per-profile tool permission for `read`/`write`/`shell`/`network`/`delegate`. Persisted by the approval prompt's "Trust". |
| `agent.trusted_folders` | array of paths | `[]` (union of global) | Extra folder capabilities. In-home entries may be written without prompting; external entries still require one-time approval per action. Add eligible entries with `/trust-folder` or the prompt. The whole `[agent]` table (incl. `max_iterations`, `tool_mode`, `unattended`) is per-profile overridable. |

Example:

```toml
display_name = "Writing Partner"
provider = "bailian"
model = "qwen3.6-plus"
session_context_turns = 5
```

`memories/user.jsonl` stores durable user facts, `memories/preferences.jsonl` stores durable preferences, and `memories/auto_short.jsonl` stores short-term notes. Each JSONL entry stores rich metadata such as `priority`, `confidence`, `stability`, `source`, `source_type`, `scope`, timestamps, optional `evidence`, optional `reason`, optional `conflict_key`, and supersession status.

Memory is context, not authority. Human-authored profile instructions and the current user message outrank memory. Prompt injection receives compact grouped memory blocks rather than raw JSON.

marifold creates memory files for existing profiles when memory is first prepared, read, or written. When memory is on, marifold asks the model to emit hidden memory control blocks for useful saves or forgets, strips those blocks from visible replies and session history, applies JSONL updates after the turn, applies conservative prompt fallback extraction, applies prompt-driven forgets, and trims low-priority short-term memory. Recall uses priority cutoffs: normal mode recalls priority `0..3`, thinking mode recalls priority `0..10`, and simple greetings recall only priority `0`.

marifold also reads legacy Markdown memory files in `memories/user.md`, `memories/preferences.md`, `memories/notes.md`, and `memories/auto_short.md` as read-only fallback prompt context.

## Relationship to priest-typescript

marifold depends on `@priest-ai/core` for provider calls, streaming, native tool-call transport, context assembly, and SQLite-backed session continuity. Priest owns everything about talking to models; marifold owns everything about acting on the world.

marifold owns the product-level layer: CLI commands, marifold config, unified profile-instruction loading, profile memory selection, concrete agent tools, approval policy, task state, and user-facing runtime behavior.
