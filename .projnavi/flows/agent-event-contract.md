# Flow: the AgentEvent render contract

The single most cross-cutting seam. Every client renders `AgentEvent`s; changing the union ripples to all of them.

1. `packages/core/src/agent/AgentEvents.ts` — the `AgentEvent` union. Its legacy `verification` variant is deprecated compatibility surface and is not emitted by the current runner.
2. `packages/core/src/agent/AgentRunner.ts` — emits current events via `run()` AsyncGenerator; focused checks appear as ordinary tool request/result events.
3. `packages/cli/src/commands/agent.ts`, `packages/tui/src/core/eventView.ts`, and `apps/web/src/state/thread.ts` consume the contract; the service serializes it verbatim over SSE.
4. Future clients add renderers over the same semantic union and must tolerate unknown or deprecated variants.

When adding an event variant: update the union and producer, update every active
renderer/reducer and service documentation, and preserve tolerant handling for
older or newer peers at the wire boundary.
