# Client Module

`@marifold/client` (`packages/client/src/`): the typed HTTP/SSE client shared by the TUI, CLI, and Web UI. It must not depend on core at runtime.

Use this note for: API requests and errors, the session-owner header, SSE parsing, following run events, session lease helpers, workspace startup selection, or composer tokens.

- `packages/client/src/client.ts` — `createApiClient` (`request`/`stream`, bearer token, per-client `x-marifold-session-owner` header, workspace-forwarded base URL, client environment on run/chat requests) and `MarifoldApiError`.
- `packages/client/src/sse.ts` — `parseSse`; `packages/client/src/followRun.ts` — `followRunEvents`, a resumable read-only follow of `/v1/runs/:id/events`.
- `packages/client/src/sessionLease.ts` — `acquireSessionLease`, `takeOverSessionLease`, `releaseSessionLease`, `isSessionBusy`, and `renewSessionLease` (15-second renewal; only `SESSION_BUSY` ends it and calls `onLost`).
- `packages/client/src/workspaceStartup.ts` (`startupWorkspaces`) and `packages/client/src/composerTokens.ts` (`composerTokenBefore`).
- Consumers: `packages/tui/src/core/RemoteRuntime.ts`, `packages/tui/src/ui/App.tsx`, the Web UI (mostly through `apps/web/src/api/client.ts` and `apps/web/src/api/sessions.ts`), `packages/cli/src/commands/WorkspaceClient.ts`.

Tests: `packages/client/tests/sessionLease.test.ts`, `packages/client/tests/workspace.test.ts`, `packages/client/tests/composerTokens.test.ts`.
