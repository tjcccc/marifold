# Flow: the AgentEvent render contract

The single most cross-cutting seam. Every client renders `AgentEvent`s; changing the union ripples to all of them.

1. `packages/core/src/agent/AgentEvents.ts` — the `AgentEvent` union (status, plan, step, text, tool_request, approval_request, approval_decision, tool_result, verification, error, done).
2. `packages/core/src/agent/AgentRunner.ts` — emits the events via `run()` AsyncGenerator.
3. `packages/cli/src/commands/agent.ts` — the only current renderer; maps each event to terminal output and implements the readline `ApprovalHandler`.
4. Future TUI/Web/Apple clients each add a renderer over the same union — no core change should be needed.

When adding an event variant: update the union, emit it in AgentRunner, and handle it in the CLI renderer (and document it for future clients).
