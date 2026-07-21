# Marifold Service API (v1)

The HTTP contract for `marifold service` — the local API every app client
(Web UI first, desktop/mobile later) is built on. One service process powers
the HTTP API, the schedule runner, and the Telegram bridge.

- **Base URL:** `http://127.0.0.1:32140` (`--host` / `--port`; binding is
  loopback-only in this release)
- **Versioning:** all routes are under `/v1` except `GET /health`. Additive
  changes (new fields, new event types) may land within v1 — clients must
  ignore unknown fields and unknown SSE event types. Breaking changes get a
  new prefix.
- **Start:** `marifold service [--log] [--token <t> | --token-env <NAME>]
  [--cors-origin <origin>]...`

## Authentication

Off by default (bare loopback). When a bearer token is configured, every
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
cors_origins = ["http://localhost:5173"]
# web_dir = "/path/to/apps/web/dist"  # host the built Web UI at / (or --web-dir)
```

Failures return `401` with error code `UNAUTHORIZED`.

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
- **Same-origin exception:** an `Origin` equal to the request's own loopback
  `Host` always passes — that is the service-hosted Web UI talking to itself
  (browsers send `Origin` on every non-GET request, same-origin included).
- Any other `Origin` → `403 ORIGIN_FORBIDDEN`, even before auth. With no
  `cors_origins` configured, all cross-origin browser requests are rejected.
- Requests without an `Origin` header (curl, native apps) are unaffected.
- A non-loopback `Host` header is rejected `403` (DNS-rebinding hardening).

## Errors

Every non-2xx response uses one envelope:

```json
{ "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run not found: run_x", "details": { "runId": "run_x" } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `CONFIG_INVALID` | 400 | Malformed request body / parameter |
| `PROFILE_INVALID`, `MEMORY_INVALID`, `TASK_INVALID`, `SCHEDULE_INVALID`, `AGENT_RUN_INVALID` | 400 | Domain validation failed |
| `UNAUTHORIZED` | 401 | Missing/invalid bearer token |
| `ORIGIN_FORBIDDEN` | 403 | Disallowed browser origin or non-loopback Host |
| `NOT_FOUND` | 404 | Unknown route |
| `TASK_NOT_FOUND`, `SESSION_NOT_FOUND`, `SCHEDULE_NOT_FOUND`, `RUN_NOT_FOUND`, `APPROVAL_NOT_FOUND`, `CONFIG_FILE_NOT_FOUND` | 404 | Unknown resource |
| `RUN_LIMIT_EXCEEDED` | 429 | Too many active agent runs (default limit 5) |
| anything else | 500 | Internal error |

## SSE conventions

Two streaming routes, one framing (`text/event-stream`):

```
id: 7                      ← runs stream only
event: tool_request
data: {"type":"tool_request", ...}
```

- `data:` is always a self-describing JSON object (it repeats the event
  name as `type`), so generic `onmessage` parsing works too.
- Comment frames (`: ping`) arrive every 15 s as keepalives — ignore them.
- **Runs stream** (`/v1/runs/:id/events`) is *resumable*: every frame has an
  `id:` sequence number, a `retry: 3000` hint is sent at open, and a
  reconnect with `Last-Event-ID: <seq>` (or `?after=<seq>`) replays only
  later events. Very old events can drop out of the buffer (it is bounded);
  backfill from the run's durable task record (`GET /v1/tasks/:taskId`).
- **Chat stream** (`/v1/chat/stream`) is *one-shot*: it is a POST whose
  reconnect would re-run the prompt, so it has no ids and no resume. Events:
  `chunk` (`{"text": "..."}`) repeated, then `done` (`{}`); on failure an
  `error` event (error envelope shape) followed by `done`. Client disconnect
  aborts the in-flight model call.

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
| `GET /v1/config` | Sanitized config — secrets are replaced by `hasApiKey`-style booleans; includes the resolved `agent` section (approval defaults, trusted folders) and a sanitized `service` view (`webDir?`, `tokenEnv?`, `corsOrigins`, `hasToken`) |
| `PATCH /v1/config` | Body `{ key, value }` (both strings) — sets one dotted config key with **exactly** the CLI `config set` routing and validation (`default.*`, `paths.*`, `memory.*`, `service.*`, `providers.<name>.*`; `service.cors_origins` takes a comma-separated list, `""` clears optional keys). Returns the sanitized config |
| `GET /v1/providers` | `providers: [{ name, type, baseUrl?, hasApiKey, hasOauthToken, ... }]` |
| `GET /v1/providers/status` | Live reachability probe per provider (CLI `provider status`): adds `configured`, `reachable` (`null` = not probeable), `models`, `message`. Sanitized — key/token presence booleans and env-var *names* only |
| `GET /v1/providers/:name/models` | Models the provider serves right now (feeds model pickers): `{ provider, reachable, models, message }`. Never errors — unconfigured/unreachable providers return an empty list with a message |
| `GET /v1/models` | `default: { provider, model }` and saved `options: ["provider/model", ...]` |
| `POST /v1/models` → 201 | Body `{ provider, model, type?, baseUrl?, apiKeyEnv? }` — add a saved option, creating/updating the provider entry (CLI `model add`). **Raw `api_key` values are not accepted over the wire** — set the env-var name and keep secrets in the environment or config file. Returns the models view |
| `DELETE /v1/models` | Body `{ provider, model }` — remove a saved option; `{ removed, wasDefault }` (the default itself is left untouched) |
| `PUT /v1/models/default` | Body `{ provider, model }` — set the global default (also registers the option). Returns the models view |

### Profiles and memories

| Route | Returns |
|---|---|
| `GET /v1/profiles` | Profile summaries |
| `GET /v1/profiles/:name` | Profile detail (files, settings) |
| `POST /v1/profiles` → 201 | Body `{ name }` — scaffold a new profile directory (PROFILE/RULES/CUSTOM.md + profile.toml, the `profile init` layout). Duplicate or invalid names are 400. Follow up with `PATCH` / avatar `PUT` for initial settings |
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
| `GET /v1/sessions?limit=&profile=` | Recent sessions (default limit 50). Each summary carries `preview?` — the first user message, whitespace-collapsed and truncated to ~80 chars — for use as a display title; absent when the session has no user turn |
| `GET /v1/sessions/:id` | Session detail with turns; 404 `SESSION_NOT_FOUND` |
| `DELETE /v1/sessions/:id` | `{ deleted: boolean }` |

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

### Agent runs (live layer)

An agent run executes a multi-step objective with tools (file read/write,
shell, web search, profile delegation) under the profile's approval policy.
The run itself is ephemeral in-service state; its durable record is a task
(`run.taskId` → `GET /v1/tasks/:taskId`). Finished runs stay queryable for
~5 minutes.

**`POST /v1/runs` → 201**

```json
{ "objective": "Summarize ~/notes into notes.md",
  "profile": "default", "provider": "ollama", "model": "gemma4:e4b",
  "sessionId": "abc", "cwd": "/Users/me/project", "think": false,
  "originalImages": false,
  "images": [{ "data": "<base64>", "mediaType": "image/png" }, { "url": "https://..." }],
  "instructions": ["Write in English."], "maxIterations": 20,
  "forcePlan": false, "lean": false }
```

Only `objective` is required. `images` follow the same shape as chat/ask
(base64 `{data, mediaType}` or URL; exactly one of `data`/`url` per entry)
and are attached to the objective on the first model turn. The service
accepts JSON bodies up to 25 MiB to make room for base64 payloads. Returns the **RunRecord**:

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
  "eventCount": 0, "pendingApprovals": [] } }
```

`status` is `running | blocked | completed | failed | cancelled`. Unset
fields are omitted, not null: `taskId` appears once the first event lands,
and `finishedAt` / `summary` / `usage` arrive with the terminal `done`. **Trust model:** `cwd` scopes where file
writes are silent; everything else asks per the profile's `[agent]` approval
policy. Auth + loopback is the access boundary — give tokens only to
clients you'd let run the agent.

| Route | Returns |
|---|---|
| `GET /v1/runs` | All live + recently finished RunRecords, newest first |
| `GET /v1/runs/:id` | One RunRecord (poll `pendingApprovals` if not using SSE) |
| `GET /v1/runs/:id/events` | Resumable SSE of AgentEvents (below) |
| `POST /v1/runs/:id/approvals/:requestId` | Answer an approval (below) |
| `POST /v1/runs/:id/steer` `{ "text": "..." }` → 202 | Queue mid-run guidance; applied before the next model turn, echoed as a `steering` event |
| `POST /v1/runs/:id/cancel` → 202 | Idempotent; returns current `status`. Unblocks a pending approval immediately; the run finishes `cancelled` |

#### The AgentEvent stream

Each SSE frame's `event:` name equals `data.type`. The union (verbatim from
core — the same contract the TUI renders):

```jsonc
{ "type": "status",  "taskId": "task_x", "status": "running" }            // first event; also on terminal transitions
{ "type": "plan",    "taskId": "task_x", "plan": [{ "id": "s1", "text": "...", "status": "pending", ... }] }
{ "type": "step",    "taskId": "task_x", "stepId": "s1", "text": "...", "status": "completed" }
{ "type": "text",    "text": "model output for this turn" }
{ "type": "steering","taskId": "task_x", "text": "user guidance just applied" }
{ "type": "tool_request",  "call": { "id": "call_0", "tool": "write_file", "kind": "write",
                                      "input": { "path": "...", "content": "..." },
                                      "summary": "write 12B to /tmp/x" } }
{ "type": "approval_request", "request": { "id": "call_0", "tool": "write_file", "kind": "write",
                                            "summary": "write 12B to /tmp/x", "input": { },
                                            "escalated": true, "escalationReason": "outside the working directory",
                                            "escalatedPath": "/tmp/x" } }
{ "type": "approval_decision", "requestId": "call_0", "approved": true, "source": "user", "reason": "..." }
{ "type": "tool_result", "callId": "call_0", "tool": "write_file", "summary": "wrote 12B to /tmp/x", "isError": false }
{ "type": "error", "code": "...", "message": "..." }
{ "type": "done",  "taskId": "task_x", "status": "completed", "summary": "...",
  "usage": { "inputTokens": 900, "outputTokens": 120, "totalTokens": 1020,
             "cachedInputTokens": 0, "estimatedCostUSD": 0.001 } }        // always the last event
```

Tool `kind` is `read | write | shell | network | delegate`. Render unknown
event types as no-ops — the union may grow within v1.

#### The approval sequence

1. The stream emits `approval_request`; the run **blocks**. The request also
   appears in the RunRecord's `pendingApprovals` (for polling clients).
2. The client answers within 5 minutes (else auto-deny):

   `POST /v1/runs/:id/approvals/:requestId` with `{ "action": "..." }`
   - `once` — approve this call only.
   - `always` — approve and persist "always allow `<kind>`" to the profile
     (future runs inherit it); later same-kind calls in this run stop asking.
   - `trust` — only when the request has an `escalatedPath` (an
     out-of-workspace file write): approve and persist the target's folder
     as trusted. Otherwise `400 AGENT_RUN_INVALID`.
   - `deny` — reject; the model sees an error tool result and continues.

   Returns `{ ok, requestId, approved }`. Unknown/expired/already answered →
   `404 APPROVAL_NOT_FOUND`.
3. The stream emits `approval_decision` (`source: "user"`), so every
   attached client converges — then `tool_result`.

UX note for approval dialogs: mirror the TUI/Telegram wording — **Allow
once** (safe default) / **Always allow \<kind\>** or **Trust folder** (when
`escalatedPath` is present) / **Deny**.

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
