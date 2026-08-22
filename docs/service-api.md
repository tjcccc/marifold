# Marifold Service API (v1)

The HTTP contract for `marifold service` — the local API every app client
(Web UI first, desktop/mobile later) is built on. One service process powers
the HTTP API, the schedule runner, and the Telegram bridge.

- **Base URL:** `http://127.0.0.1:32140` by default (`--host` / `--port`). A
  non-loopback bind accepts private-network peers by default; `--public`
  accepts any source address and requires resolved bearer authentication.
- **Versioning:** all routes are under `/v1` except `GET /health`. Additive
  changes (new fields, new event types) may land within v1 — clients must
  ignore unknown fields and unknown SSE event types. Breaking changes get a
  new prefix.
- **Foreground:** `marifold service [options]` or `marifold service start [options]`
- **Background:** `marifold service start --daemon [options]`; inspect with
  `marifold status [--logs]`, restart with `marifold service restart`, and stop
  with `marifold service stop`. Restart reuses the previous safe launch options
  and mode. Raw `--token` values are not persisted, so repeat one as
  `marifold service restart --token <token>` when required.

## Authentication

Off by default on loopback and in private-network mode. Public access requires
a bearer token. When a bearer token is configured, every
**`/v1/*`** route requires it — `GET /health`, CORS preflights, and the
hosted Web UI shell (static files) stay reachable; the shell carries no
secrets and every stateful route is versioned under `/v1`:

```
Authorization: Bearer <token>
```

Configure via `config.toml` (preferred: the env indirection keeps the secret
out of the file) or CLI flags (flags win):

```toml
[service]
token_env = "MARIFOLD_SERVICE_TOKEN"   # preferred
# token = "inline-secret"             # discouraged
cors_origins = ["http://127.0.0.1:5173"]
# web_dir = "/path/to/apps/web/dist"  # host the built Web UI at / (or --web-dir)
```

Failures return `401` with error code `UNAUTHORIZED`.

The bearer token is a user-chosen shared secret, not a credential Marifold
issues or exposes through the API. Generate and store it on the service host,
preferably through `token_env`, then enter the same value in the client. The
sanitized Config screen intentionally reports only whether a token is present.

A non-loopback `--host` makes the service listen on that interface. For
example, listen on every interface while accepting only direct loopback,
private LAN, link-local, IPv6 ULA, and Tailscale (`100.64.0.0/10`) peers with:

```sh
marifold service --host 0.0.0.0
```

Then open `http://<service-host-ip>:32140`. A token remains optional but
supported in private mode. Tokenless private mode also restricts request Host
values to private IPs, loopback, single-label names, `.local`, `.ts.net`, and
the explicit bind host to resist DNS rebinding.

Accept all source addresses only through the explicit authenticated mode:

```sh
marifold service --host 0.0.0.0 --public --token-env MARIFOLD_SERVICE_TOKEN
```

`0.0.0.0` opens every active interface; binding a specific Tailscale or LAN
address is narrower. Source filtering uses the direct socket peer and ignores
forwarded-IP headers. A public reverse proxy or tunnel can make even a
loopback/private bind publicly reachable, so require a bearer token in that
topology. The API has no TLS termination; use a trusted private network or a
TLS reverse proxy.

A Web UI hosted by another Marifold instance can instead save this endpoint as
a named Connection. That is a cross-origin browser request, so this service
must allow the shell's exact origin in `cors_origins`. Native app clients send
the bearer token but are not subject to browser CORS.

**SSE exception:** native `EventSource` cannot set headers, so
`GET /v1/runs/:id/events` also accepts `?access_token=<token>`. Prefer
fetch-based SSE with the header; the query form exists only for
`EventSource` and may appear in local logs.

## CORS and origin policy

Browser access is allowlist-only, exact-match against `cors_origins`:

- Allowed origin → `Access-Control-Allow-Origin` echoes it; preflight
  `OPTIONS` short-circuits to `204` with
  `Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`,
  `Access-Control-Allow-Headers: authorization, content-type, last-event-id`.
- **Same-origin exception:** an `Origin` equal to the request's allowed `Host`
  always passes — that is the service-hosted Web UI talking to itself
  (browsers send `Origin` on every non-GET request, same-origin included).
- Any other `Origin` → `403 ORIGIN_FORBIDDEN`, even before auth. With no
  `cors_origins` configured, all cross-origin browser requests are rejected.
- Requests without an `Origin` header (curl, native apps) are unaffected.
- A non-loopback `Host` header is rejected `403` under the default loopback
  bind. Tokenless private mode allows only private/local Host forms; an
  authenticated remote bind accepts its externally addressed Host values.

## Errors

Every non-2xx response uses one envelope:

```json
{ "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run not found: run_x", "details": { "runId": "run_x" } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `CONFIG_INVALID` | 400 | Malformed request body/parameter, tokenless `--public`, or `--public` on a loopback bind |
| `PROFILE_INVALID`, `MEMORY_INVALID`, `TASK_INVALID`, `SCHEDULE_INVALID`, `AGENT_TOOL_INVALID`, `AGENT_RUN_INVALID` | 400 | Domain validation failed |
| `UNAUTHORIZED` | 401 | Missing/invalid bearer token |
| `NETWORK_FORBIDDEN` | 403 | Public source address rejected by private-network mode |
| `ORIGIN_FORBIDDEN` | 403 | Disallowed browser origin or Host for the active bind scope |
| `NOT_FOUND` | 404 | Unknown route |
| `TASK_NOT_FOUND`, `SESSION_NOT_FOUND`, `SCHEDULE_NOT_FOUND`, `RUN_NOT_FOUND`, `APPROVAL_NOT_FOUND`, `USER_INPUT_NOT_FOUND`, `CONFIG_FILE_NOT_FOUND` | 404 | Unknown resource |
| `PROVIDER_ERROR` | 502 | Upstream provider rejected the request or returned no usable response |
| `RUN_LIMIT_EXCEEDED` | 429 | Too many active agent runs (default limit 5) |
| anything else | 500 | Internal error |

## SSE conventions

Two streaming routes, one framing (`text/event-stream`):

```
id: 7                      ← runs stream only
event: tool_request
data: {"type":"tool_request", ...}
```

- Run-stream `data:` is a self-describing `AgentEvent` object that repeats the
  event name as `type`. Chat frames use the `event:` name with a compact
  `{text}` or `{}` payload.
- Comment frames (`: ping`) arrive every 15 s as keepalives — ignore them.
- **Runs stream** (`/v1/runs/:id/events`) is *resumable*: every frame has an
  `id:` sequence number, a `retry: 3000` hint is sent at open, and a
  reconnect with `Last-Event-ID: <seq>` (or `?after=<seq>`) replays only
  later events. Very old events can drop out of the buffer (it is bounded);
  backfill from the run's durable task record (`GET /v1/tasks/:taskId`).
- **Chat stream** (`/v1/chat/stream`) is *one-shot*: it is a POST whose
  reconnect would re-run the prompt, so it has no ids and no resume. Events:
  optional `reasoning` (`{"text": "..."}`) safe-summary fragments, `chunk`
  (`{"text": "..."}`) answer fragments, then `done`
  (`{"latencyMs": 1234, "usage": {"inputTokens": 120, "outputTokens": 30,
  "totalTokens": 150}}`). `usage` is omitted when the provider does not report
  it. On failure an `error` event (error envelope shape) is followed by an
  empty `done`. Opaque provider reasoning continuation is never serialized.
  Client disconnect aborts the in-flight model call.

## Route reference

Responses are `{ "ok": true, ... }` unless noted. Bodies are JSON.

### Health and status

| Route | Returns |
|---|---|
| `GET /health` | `{ ok, service: "marifold", apiVersion: "v1" }` — auth-exempt liveness probe |
| `GET /v1/status` | config path, `default` settings, state paths |

### Config, providers, models

| Route | Returns |
|---|---|
| `GET /v1/config` | Sanitized config — secrets are replaced by `hasApiKey`-style booleans; includes resolved `agent` defaults, sanitized `webSearch`, and the `service` view (`webDir?`, `tokenEnv?`, `corsOrigins`, `hasToken`) |
| `PATCH /v1/config` | Body `{ key, value }` (both strings) — sets one dotted config key with **exactly** the CLI `config set` routing and validation (`default.*`, `paths.*`, `memory.*`, `agent.*`, `agent.approval.*`, `web_search.*`, `service.*`, `providers.<name>.*`; comma lists and empty-string clearing follow each key's CLI semantics). Returns the sanitized config |
| `GET /v1/providers` | `providers: [{ name, type, baseUrl?, hasApiKey, hasOauthToken, ... }]` |
| `GET /v1/providers/status` | Live reachability probe per provider (CLI `provider status`): adds `configured`, `reachable` (`null` = not probeable), `models`, `message`. Sanitized — key/token presence booleans and env-var *names* only |
| `GET /v1/providers/:name/models` | Models the provider serves right now (feeds model pickers): `{ provider, reachable, models, message }`. Never errors — unconfigured/unreachable providers return an empty list with a message |
| `DELETE /v1/providers/:name` | Remove the provider's local config, stored credentials, and saved model options. Refuses the global default provider and providers referenced by profile overrides. Returns `{ removed, removedModels, config, models }`; provider-owned models and remote accounts are untouched |
| `GET /v1/models` | `default: { provider, model }` and saved `options: ["provider/model", ...]` |
| `POST /v1/models` → 201 | Body `{ provider, model, type?, baseUrl?, apiKeyEnv? }` — add a saved option, creating/updating the provider entry (CLI `model add`). **Raw `api_key` values are not accepted over the wire** — set the env-var name and keep secrets in the environment or config file. Returns the models view |
| `DELETE /v1/models` | Body `{ provider, model }` — remove a saved option; `{ removed, wasDefault }` (the default itself is left untouched) |
| `PUT /v1/models/default` | Body `{ provider, model }` — set the global default (also registers the option). Returns the models view |

### Profiles and memories

| Route | Returns |
|---|---|
| `GET /v1/profiles` | Profile summaries, pinned first and then by recent session activity. Summaries may carry contact-list metadata: `pinned?`, `updatedAt?`, and `preview?` (the first non-empty line of the latest assistant response in the profile's most recent session) |
| `GET /v1/profiles/:name` | Profile detail (files, settings) |
| `POST /v1/profiles` → 201 | Body `{ name }` — scaffold a new profile directory (PROFILE/RULES/CUSTOM.md + profile.toml, the `profile init` layout). Duplicate or invalid names are 400. Follow up with `PATCH` / avatar `PUT` for initial settings |
| `PATCH /v1/profiles/:name/display` | Body `{ pinned: boolean }` — persist contact-list pin state and return the freshly sorted profile summaries. Display metadata never enters profile instructions or model context |
| `DELETE /v1/profiles/:name` | Remove the stored profile directory/JSON and its display metadata. Deletes instructions, memories, skills, and avatar but retains SQLite session history. The built-in/current-default profile cannot be removed, and active requests/runs must be cancelled first |
| `GET /v1/profiles/:name/avatar` | Raw avatar image bytes (`content-type` = stored media type, `ETag` + `no-cache`; honors `If-None-Match` with 304). 404 `AVATAR_NOT_FOUND` when unset. Auth'd clients fetch with headers and render a blob URL (`<img src>` can't send a bearer token) |
| `PUT /v1/profiles/:name/avatar` | Body `{ data: <base64>, mediaType }` — store the avatar (PNG/JPEG/WebP, ≤1 MB; replaces any previous one). Returns the fresh profile detail (summaries carry `avatar?: { mediaType }`) |
| `DELETE /v1/profiles/:name/avatar` | `{ removed: boolean }` + fresh profile detail |
| `PATCH /v1/profiles/:name` | Update per-profile settings. Optional fields: `mode` (`"agent"\|"chat"`), `provider`+`model` (both strings, or both `null` to clear the override), `memories`/`think` (`boolean\|null`), `maxContextTokens` (`int\|null`), `sessionContextTurns` (`int ≥ 0\|"all"\|null`), `approval` (`{ read\|write\|shell\|network\|delegate: "allow"\|"ask"\|"deny"\|null }` — `null` clears the override so the kind inherits again). Absent = untouched. Returns the fresh profile detail |
| `PUT /v1/profiles/:name/files/:file` | Overwrite `PROFILE`/`RULES`/`CUSTOM.md` (`:file` ∈ `profile\|rules\|custom`); body `{ content }`. Returns the fresh profile detail |
| `POST /v1/profiles/:name/trusted-folders` | Body `{ folder }` — add a trusted folder (safety refusals for broad/sensitive roots are 400) |
| `DELETE /v1/profiles/:name/trusted-folders` | Body `{ folder }` (in the body — folders contain slashes) — `{ removed: boolean }` + fresh profile detail |
| `GET /v1/profiles/:name/memories?all=&limit=` | Structured memory records; `all=true` includes superseded |
| `DELETE /v1/profiles/:name/memories/:id?mode=forget\|delete` | Exact-by-id: `forget` (default) supersedes the entry (recoverable); `delete` removes it permanently. Returns the fresh active list |

Memory **content** authoring stays model-driven (`memory_save` blocks) — there is deliberately no memory-create route.

### Sessions

| Route | Returns |
|---|---|
| `GET /v1/sessions?limit=&profile=&archived=&q=` | Sessions matching the active/archived view and optional case-insensitive title/first-prompt query, with pinned sessions first. Summaries may carry sidebar-only `title?`, `pinned?`, `archived?`, plus the first-user-message `preview?` |
| `GET /v1/sessions/:id` | Session detail with all turns. Assistant turns may include durable `responseMetrics: { mode, provider, model, think, startedAt, finishedAt, latencyMs, usage? }`; usage may carry input/output/total/cached/reasoning tokens and estimated USD cost. Embedded display-only images are references (`{ kind: "image", mediaType, ref: { userTurnIndex, attachmentIndex } }`) rather than base64; remote attachments retain `url`. Metrics and images are not replayed into model context. 404 `SESSION_NOT_FOUND` |
| `GET /v1/sessions/:id/attachments/:userTurnIndex/:attachmentIndex` | Authenticated binary delivery for one embedded transcript image, with its stored image content type. This keeps large base64 payloads out of session JSON |
| `PATCH /v1/sessions/:id` | Update sidebar-only metadata with `{ title?: string \| null, pinned?: boolean, archived?: boolean }`. `null` clears a custom title. Does not change the session id, transcript, model context, or conversation recency. Returns the updated session; 404 `SESSION_NOT_FOUND` |
| `DELETE /v1/sessions/:id` | `{ deleted: boolean }`. Refuses with `AGENT_RUN_INVALID` while a run for that session is active, preventing its final save from recreating deleted history |
| `POST /v1/sessions/:id/truncate` | Low-level destructive operation: body `{ fromUserTurnIndex }` deletes that user turn and everything after it. The Web UI does **not** use this for prompt editing. Returns `{ truncated, removedTurns }`; 404 `SESSION_NOT_FOUND` |

### Chat

**`POST /v1/ask`** — one-shot request/response.

```json
{ "prompt": "Hello", "profile": "default", "provider": "ollama", "model": "gemma4:e4b",
  "sessionId": "abc", "memories": false, "think": false,
  "originalImages": false,
  "images": [{ "data": "<base64>", "mediaType": "image/png" }, { "url": "https://..." }] }
```

Only `prompt` is required. Returns `{ response: { ok, text, settings, latencyMs?, session? } }`.

**`POST /v1/chat/stream`** — same body; SSE response (see conventions above).
Pass `sessionId` to continue a conversation; sessions are created on demand.
To regenerate a historical exchange, also pass `replaceUserTurnIndex` (zero
based among persisted user turns). The model receives only the earlier prefix;
the selected user/assistant pair is replaced in place and later turns remain.
`instructions` supplies request-scoped authoritative guidance. `userTurn` may
carry a different display/persistence value than the model-facing `prompt`;
direct skill runs use it to retain the original `$skill …` invocation. With
`isolated: true`, a chat turn does not replay the session to the model, but its
clean user/assistant pair is still appended to that durable session.
`profileContext: false` omits PROFILE/RULES/CUSTOM text while retaining
request-scoped instructions and Marifold's minimal runtime framing. App routes
set this server-side from the definition; ordinary clients should not
use it as a way to bypass profile policy accidentally.
Embedded/URL image sources are retained beside their user turn so clients can
restore transcript thumbnails after navigation or reload; local filesystem
paths are never exposed through this API.
Successful session-backed chat and agent responses also retain content-free
completion metrics beside the exchange. Editing replaces that exchange's
metrics, while truncation/deletion removes the matching companion rows.

### Skill invocation

**`POST /v1/skills/resolve`** resolves one direct invocation before chat or
agent execution.

```json
{ "profile": "default", "invocation": "$make-grok-imagine-prompt \"summer morning\"" }
```

The response contains `{ invocation: { name, userTurn, prompt, instructions,
mode?, missing, usage } }`. `prompt` is model-facing while `userTurn` is the
original transcript text. `instructions` contains the expanded selected skill
body and its exact bundled-file location; clients must not ask the model to
search for the skill. Unknown skills return 404 `SKILL_NOT_FOUND`; invalid
invocations return 400 `SKILL_INVALID`. A non-empty `missing` list means the
client must collect the required variables before starting a run.

### Apps

App definitions stay on the service host. Clients receive normalized JSON
and submit typed values only:

| Route | Returns |
|---|---|
| `GET /v1/apps` | `{ apps: AppDefinition[] }`, sorted by display title. Invalid local definitions are skipped so one bad bundle does not break the catalog |
| `GET /v1/apps/:name` | `{ app: AppDefinition }`; 404 `APP_NOT_FOUND` |
| `POST /v1/apps/:name/actions/:action/stream` | One-shot chat SSE for a v0 actor Skill action |

The action body is:

```json
{
  "values": {
    "source_text": "Good morning",
    "target_language": "Japanese"
  }
}
```

The server loads `<apps_dir>/<name>/app.toml`, validates the submitted
input/state values, resolves the action's declared actor profile and its
profile/global Skill, expands named arguments, and applies the definition's
execution policy. The client cannot submit a profile, prompt, Skill name,
permissions, session ID, or execution flags. Output arrives as the same
`chunk`/`done` SSE sequence as chat. App actions neither replay nor write Agent
sessions.

v0 executes chat-mode `kind = "skill"` actions only. Invalid definitions or
values return 400 `APP_INVALID`; the complete schema and example are in
[docs/app.md](app.md).

### Agent runs (live layer)

An agent run executes a multi-step objective with tools (file read/write,
shell, web search, profile delegation) under the profile's approval policy.
The run itself is ephemeral in-service state; its durable record is a task
(`run.taskId` → `GET /v1/tasks/:taskId`). Finished runs stay queryable for
~5 minutes.

**`POST /v1/runs` → 201**

```json
{ "objective": "Summarize ~/notes into notes.md",
  "userTurn": "$summarize ~/notes",
  "profile": "default", "provider": "ollama", "model": "gemma4:e4b",
  "sessionId": "abc", "replaceUserTurnIndex": 1,
  "cwd": "/Users/me/project", "think": false,
  "originalImages": false,
  "images": [{ "data": "<base64>", "mediaType": "image/png" }, { "url": "https://..." }],
  "files": [{ "name": "v23.xlsx",
              "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "data": "<base64>" }],
  "instructions": ["Write in English."], "maxIterations": 20,
  "forcePlan": false, "lean": false }
```

Only `objective` is required. `images` follow the same shape as chat/ask
(base64 `{data, mediaType}` or URL; exactly one of `data`/`url` per entry)
and are attached to the objective on the first model turn. The service
accepts JSON bodies up to 25 MiB to make room for base64 payloads. Returns the **RunRecord**:

`files` contains original file bytes for agent tools, limited to 16 MiB
aggregate. Files are name-sanitized and staged read-only under the private run's
`input/` directory; the model receives their paths and any separately extracted
prompt text, not the raw bytes.

For a resolved skill, `objective` carries the model-facing prompt,
`instructions` carries the resolved body, and `userTurn` carries the original
`$skill …` text stored in the transcript. Skill agent runs set `lean: true`, so
they skip the optional planning pass and verbose agent framing and do not receive prior session turns.

With `sessionId`, optional `replaceUserTurnIndex` regenerates that historical
exchange using only its earlier prefix as context, then replaces it in place;
later exchanges retain their original order.

Local and base64 images are decoded and validated in core, limited to four and
16 MiB aggregate source bytes, MIME-corrected, and optimized before the provider
request. URL images remain remote references. Set `originalImages: true` for a
single request to preserve supported JPEG/PNG/WebP/GIF encoded bytes; validation
and safety limits still apply. The TUI/Web UI expose this as
`/attach-original <prompt>`.

```json
{ "ok": true, "run": {
  "id": "run_20260704151200_ab12cd34", "objective": "...", "profile": "default",
  "status": "running", "sessionId": "abc",
  "createdAt": "2026-07-04T15:12:00.000Z",
  "eventCount": 0, "pendingApprovals": [], "pendingUserInputs": [] } }
```

`status` is `running | blocked | completed | failed | cancelled`. Unset
fields are omitted, not null: `taskId` appears once the first event lands,
and `finishedAt` / `summary` / `usage` arrive with the terminal `done`. **Trust model:**
`cwd`, configured in-home trusted folders, and the private run directories form
the shell capability set. On macOS, shell network is denied and all other host
writes remain blocked even after approval. External paths always require
one-time approval; global/system runtime writes are refused. Auth + loopback is
still an important access boundary — give tokens only to clients you'd let run
the agent within those capabilities.

| Route | Returns |
|---|---|
| `GET /v1/runs` | All live + recently finished RunRecords, newest first |
| `GET /v1/runs/:id` | One RunRecord (poll `pendingUserInputs` / `pendingApprovals` if not using SSE) |
| `GET /v1/runs/:id/events` | Resumable SSE of AgentEvents (below) |
| `POST /v1/runs/:id/inputs/:requestId` | Submit every answer for one clarification checkpoint (below) |
| `POST /v1/runs/:id/approvals/:requestId` | Answer an approval (below) |
| `POST /v1/runs/:id/steer` `{ "text": "..." }` → 202 | Queue mid-run guidance; applied before the next model turn, echoed as a `steering` event |
| `POST /v1/runs/:id/cancel` → 202 | Idempotent; returns current `status`. Unblocks a pending clarification or approval immediately; the run finishes `cancelled` |

#### The AgentEvent stream

Each SSE frame's `event:` name equals `data.type`. The union (verbatim from
core — the same contract the TUI renders):

```jsonc
{ "type": "status",  "taskId": "task_x", "status": "running" }            // first event; also on terminal transitions
{ "type": "plan",    "taskId": "task_x", "plan": [{ "id": "s1", "text": "...", "status": "pending", ... }] }
{ "type": "step",    "taskId": "task_x", "stepId": "s1", "text": "...", "status": "completed" }
{ "type": "reasoning", "summary": "safe provider reasoning summary" }
{ "type": "text",    "text": "checking the referenced files", "phase": "progress" }
{ "type": "text",    "text": "the completed answer", "phase": "final" }
{ "type": "steering","taskId": "task_x", "text": "user guidance just applied" }
{ "type": "tool_request",  "call": { "id": "call_0", "tool": "write_file", "kind": "write",
                                      "input": { "path": "...", "content": "..." },
                                      "summary": "write 12B to /tmp/x" } }
{ "type": "approval_request", "request": { "id": "call_0", "tool": "write_file", "kind": "write",
                                            "summary": "write 12B to /tmp/x", "input": { },
                                            "escalated": true, "escalationReason": "outside the working directory",
                                            "escalatedPath": "/tmp/x", "persistable": false } }
{ "type": "approval_decision", "requestId": "call_0", "approved": true, "source": "user", "reason": "..." }
{ "type": "user_input_request", "request": { "id": "call_1", "questions": [
  { "id": "style", "header": "Visual style", "question": "What style do you prefer?",
    "multiple": true,
    "options": [{ "id": "apple", "label": "Apple", "description": "Quiet and restrained" },
                { "id": "material", "label": "Material" }] }] } }
{ "type": "user_input_response", "response": { "requestId": "call_1",
  "answers": [{ "questionId": "style", "optionIds": ["apple", "material"],
                "value": "Apple, Material" }] } }
{ "type": "tool_result", "callId": "call_0", "tool": "write_file", "summary": "wrote 12B to /tmp/x", "isError": false }
{ "type": "error", "code": "...", "message": "..." }
{ "type": "done",  "taskId": "task_x", "status": "completed", "summary": "...",
  "usage": { "inputTokens": 900, "outputTokens": 120, "totalTokens": 1020,
             "cachedInputTokens": 0, "reasoningTokens": 80,
             "estimatedCostUSD": 0.001 } }                               // always the last event
```

Tool `kind` is `read | write | shell | network | delegate | interaction`; the
last value identifies `ask_user` and is not approval-controlled. Render unknown
event types as no-ops — the union may grow within v1. A `text.phase` of
`progress` identifies model commentary emitted before a tool call; `final`
identifies the completed answer. Treat an omitted phase as `final` for
compatibility with older streams.
`reasoning.summary` is provider-designated safe summary text. Clients may show
it as secondary progress, but must not expect or request a provider's opaque
reasoning continuation payload; that remains inside the model transport.

#### The clarification sequence

`ask_user` is optional model behavior, not a mandatory stage of every run. The
agent instructions reserve it for essential missing information that could
materially change the result; otherwise the model should proceed with a
reasonable assumption. A request contains one to three questions, each with
two to four suggested options. Clients should also offer a free-text custom
answer. Questions are single-select by default; `multiple: true` means the
choices may be combined and clients should render checkboxes.

1. The stream emits `user_input_request`; the run blocks and the same request
   appears in `RunRecord.pendingUserInputs`.
2. The client collects one complete answer object for every question, then
   sends one request:

   ```json
   { "answers": [
     { "questionId": "style", "optionIds": ["apple", "material"] },
     { "questionId": "notes", "customText": "Use a warm gray background" }
   ] }
   ```

   to `POST /v1/runs/:id/inputs/:requestId`. Single-select questions use
   `optionId`; multi-select questions use `optionIds` and may also include
   `customText`. Option ids and question ids are checked against the pending
   request; missing, duplicate, or forged answers return
   `400 AGENT_TOOL_INVALID` without clearing the prompt. A valid answer returns
   `{ ok, requestId, accepted: true }`. Unknown, expired, or already answered
   requests return `404 USER_INPUT_NOT_FOUND`.
3. The stream emits `user_input_response`, followed by the successful
   `ask_user` `tool_result`, and the model continues the same run. The response
   event contains normalized display values so all attached clients converge.

The default live-run wait is 30 minutes. Cancellation resolves it immediately.
Unattended runs and clients without a `UserInputHandler` do not wait: the tool
returns an unavailable result to the model so it can make a reasonable
assumption or report that the missing detail is required. Clarification answers
never grant permissions; effectful calls still pass through the approval policy.

#### The approval sequence

1. The stream emits `approval_request`; the run **blocks**. The request also
   appears in the RunRecord's `pendingApprovals` (for polling clients).
2. The client answers within 5 minutes (else auto-deny):

   `POST /v1/runs/:id/approvals/:requestId` with `{ "action": "..." }`
   - `once` — approve this call only.
   - `always` — when `request.persistable !== false`, approve and persist "always allow `<kind>`" to the profile
     (future runs inherit it); later same-kind calls in this run stop asking.
   - `trust` — only when the request is persistable and has an `escalatedPath` (an
     out-of-workspace file write): approve and persist the target's folder
     as trusted. Otherwise `400 AGENT_RUN_INVALID`.
   - `deny` — reject; the model sees an error tool result and continues.

   Returns `{ ok, requestId, approved }`. Unknown/expired/already answered →
   `404 APPROVAL_NOT_FOUND`.
3. The stream emits `approval_decision` (`source: "user"`), so every
   attached client converges — then `tool_result`.

UX note for approval dialogs: mirror the TUI/Telegram wording — **Allow
once** (safe default) / **Always allow \<kind\>** or **Trust folder** (when
`escalatedPath` is present and `persistable !== false`) / **Deny**.

### Tasks (durable layer)

Task state is the persistent record of agent work (and generic task
tracking): objective, status, plan, events, summary, next action, tags.
Agent runs tag their tasks `agent` (+ `service` via runs, `scheduled` via
schedules).

| Route | Notes |
|---|---|
| `POST /v1/tasks` → 201 | `{ objective, title?, profile?, sessionId?, status?, summary?, nextAction?, tags?, plan? }` |
| `GET /v1/tasks?status=&limit=` | Summaries, newest first |
| `GET /v1/tasks/:id` | Full task (plan + events) |
| `PATCH /v1/tasks/:id` | Update status/summary/nextAction/plan/... |
| `POST /v1/tasks/:id/events` | Append `{ kind: progress\|decision\|observation\|blocker\|verification\|note, message, stepId?, metadata? }` |
| `DELETE /v1/tasks/:id` | `{ deleted: true }` |

The generic task-event kind `verification` is reserved for explicit evidence
attached by task or future Workflow producers. Current `AgentRunner` executions
perform checks through ordinary tools and do not emit a separate model self-grade.

### Schedules (read-only)

| Route | Notes |
|---|---|
| `GET /v1/schedules` | Cron schedules for unattended agent runs |
| `GET /v1/schedules/:id` | One schedule; 404 `SCHEDULE_NOT_FOUND` |

Managed via `marifold schedule ...`; schedules fire only while the service
runs.

## Client recipes

Follow a run with fetch-based SSE (header auth, manual resume):

```js
const res = await fetch(`${base}/v1/runs/${id}/events`, {
  headers: { authorization: `Bearer ${token}`, 'last-event-id': String(lastSeq) },
});
for await (const frame of parseSse(res.body)) {
  lastSeq = frame.id ?? lastSeq;
  render(frame.data);            // frame.data.type discriminates
}
```

Or with native `EventSource` (query-param auth, auto-resume):

```js
const es = new EventSource(`${base}/v1/runs/${id}/events?access_token=${token}`);
es.addEventListener('approval_request', e => showDialog(JSON.parse(e.data).request));
es.addEventListener('done', () => es.close());   // the server also ends the stream
```
