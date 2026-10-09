# Flow: the AgentEvent render contract

The single most cross-cutting seam. Every client renders `AgentEvent`s; changing the union ripples to all of them.

1. `packages/core/src/agent/AgentEvents.ts` — the `AgentEvent` union (status, plan, step, text, reasoning, steering, tool request/result, approval request/decision, user input request/response, artifact, error, done). Its legacy `verification` variant is deprecated compatibility surface and is not emitted by the current runner.
2. `packages/core/src/agent/AgentRunner.ts` — emits events from the `run()` AsyncGenerator; focused checks appear as ordinary tool request/result events.
3. `packages/core/src/runs/RunRegistry.ts` buffers sequenced events for service runs; `packages/service/src/RunRoutes.ts` serializes them verbatim over resumable SSE (`/v1/runs/:id/events`, `Last-Event-ID` replay); `docs/service-api.md` documents the wire contract.
4. Renderers: CLI `packages/cli/src/commands/agent.ts` (`renderAgentEvent`); TUI `packages/tui/src/core/eventView.ts` (`agentEventToItems`) and `packages/tui/src/core/appState.ts` (`applyAgentEvent`); Web `apps/web/src/state/thread.ts` (`applyRunEvent`, unknown variants are no-ops) fed by `followRun` in `apps/web/src/api/runs.ts`. Telegram folds events into one reply in `packages/core/src/channels/respond.ts`.
5. Future clients add renderers over the same semantic union and must tolerate unknown or deprecated variants.

When adding an event variant: update the union and producer, update every active renderer/reducer and the service documentation, and preserve tolerant handling for older or newer peers at the wire boundary.
