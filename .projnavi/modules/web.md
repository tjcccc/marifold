# Web UI Module

`@marifold/web` (`apps/web/src/`, Vite + React 19): the browser renderer of the service API, served same-origin by `marifold service` (`packages/service/src/StaticRoutes.ts`). No model-side logic; everything flows over HTTP/SSE. Design: `docs/architecture.md`, `apps/web/README.md`; tokens and conventions: `spec/ui.md`.

Use this note for: Web screens (agent, apps, config), the thread reducer and run cards, following runs over SSE, session leases and takeover in the browser, service connections, or the Web import boundary.

- Boundary: `apps/web/src/api/types.ts` is the only file that may import `@marifold/core`, and only with `import type`; a Biome `noRestrictedImports` override in `biome.json` enforces it. `apps/web/src/api/` is the only layer that builds service URLs (`runs.ts` with the resumable `followRun`, `sessions.ts`, `profiles.ts`, `apps.ts`, `chat.ts`, `misc.ts`, `client.ts` over `@marifold/client`).
- State: `apps/web/src/state/thread.ts` — `threadReducer`; `apps/web/src/state/runEvents.ts` — `applyRunEvent` folds `AgentEvent`s into run cards (unknown variants are no-ops); shapes in `threadTypes.ts`, shared item updates in `threadItems.ts`; `apps/web/src/state/followers.ts` — `RunFollowers`, one follow loop per run; `apps/web/src/state/connection.ts` — named service connections.
- Agent screen: `apps/web/src/screens/agent/useAgentController.ts` (selection, loading, thread reducer, followers, send routing), `apps/web/src/screens/agent/useSessionLease.ts` (lease renewal, pagehide release, `takeOver`), `apps/web/src/screens/agent/sessionAttachments.ts`, `apps/web/src/screens/agent/agentCommands.ts` (`/command` actions), and presentational components (`AgentScreen.tsx`, `ThreadView.tsx`, `RunCard.tsx`, `ApprovalSheet.tsx`, `QuestionSheet.tsx`, `InputBar.tsx`, `SessionList.tsx`).
- Other screens: `apps/web/src/screens/apps/` (SkillApps) and `apps/web/src/screens/config/` (providers, models, profiles, agent defaults, web search, service). Routing: `apps/web/src/lib/route.ts` + `apps/web/src/screens/useRoute.ts`. Shell: `apps/web/src/App.tsx`.

Tests: `apps/web/tests/` (`state/thread.test.ts`, `screens/agentController.test.tsx`, `api/follow.test.ts`, `components/run.test.tsx`, Playwright `e2e/web-workspace.spec.ts`).
