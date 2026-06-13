# Service Module

Loopback-only Fastify HTTP transport over core. Thin: parse, delegate, return. No business logic.

Use this note for: HTTP routes, SSE chat streaming, request parsing, or the hosted scheduler.

- `service/src/MarifoldService.ts` — `createMarifoldService` + route table: `/health`, `/v1/status|config|providers|models|profiles|sessions|ask|tasks|schedules`, SSE `/v1/chat/stream`. Hosts the scheduler unless `scheduler: false`.
- App-client image inputs accepted as base64/url on `/v1/ask` (`optionalImagesField`).
- Agent-run routes are intentionally deferred (need a bidirectional approval channel); `/v1/tasks` exposes agent progress read-only.
