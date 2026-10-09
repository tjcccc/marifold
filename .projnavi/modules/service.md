# Service Module

`@marifold/service` (`packages/service/src/`): Fastify HTTP/SSE transport over core. Thin: security, request validation, delegation, response sanitizing; no business rules. Wire contract: `docs/service-api.md`.

Use this note for: HTTP routes, SSE (run events, chat stream), request validation, security filtering, error mapping, the hosted Web UI, or which route module owns an endpoint.

- `packages/service/src/MarifoldService.ts` — `createMarifoldService`/`startMarifoldService`: builds the runtime, security hook, scheduler, Telegram bridge, run registry, workspace manager/executor, and SkillApp instances; registers the route modules; serves `/health`, `/v1/status`, `/v1/changes`, `/v1/terminal/:operation`, and `GET /v1/schedules[/:id]`.
- Route modules: `RunRoutes.ts` (`/v1/runs`: start, list, events SSE with `Last-Event-ID` replay, approvals, inputs, steer, cancel, artifacts), `SessionRoutes.ts` (`/v1/sessions`: list/get, lease and takeover, edit, truncate, compact, delete), `ChatRoutes.ts` (`/v1/ask`, SSE `/v1/chat/stream`), `ConfigRoutes.ts` (`/v1/config`, `/v1/providers`, `/v1/models`), `ProfileRoutes.ts` (`/v1/profiles`, avatars, files, trusted folders, memories), `SkillAppRoutes.ts` (`/v1/skills`, `/v1/apps`, `/v1/app-instances`), `TaskRoutes.ts` (`/v1/tasks`), `WorkspaceRoutes.ts` (`/v1/workspaces`, forwarded `/v1/workspaces/:id/api/*`), `WorkspaceScheduleRoutes.ts` (schedule mutations), `StaticRoutes.ts` (Web UI bundle with SPA fallback).
- `packages/service/src/Security.ts` — one `onRequest` hook: private-peer filtering, Host validation, CORS allowlist, optional bearer token. `Validation.ts` — body/query validators (`objectBody`, `optionalImagesField`, `optionalRunFilesField`, ...). `ServiceErrors.ts` — `normalizeError` maps errors to status codes. `Sse.ts` — SSE headers, frames, heartbeat. `ArtifactTickets.ts` — short-lived artifact download tickets.

Tests: `packages/service/tests/` (`MarifoldService.test.ts`, `MarifoldServiceRuns.test.ts`, `MarifoldServiceSecurity.test.ts`, `MarifoldWorkspaces.test.ts`); they resolve core from its built `dist`.
