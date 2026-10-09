# TUI Module

`@marifold/tui` (`packages/tui/src/`): the Ink/React terminal renderer of the `AgentEvent` contract and the primary interactive surface. ESM-only; the CommonJS CLI loads it through a dynamic `import()` for a bare `marifold`. No model-side logic. Design: `docs/tui.md`, `docs/architecture.md`; palette and conventions: `spec/ui.md`.

Use this note for: TUI rendering, slash commands, input grammar, the run/approval/skill controller hooks, session resume and takeover in the terminal, or local versus service-connected TUI runtimes.

- `packages/tui/src/runTui.tsx` — entry: builds a local `MarifoldRuntime` or a service-connected shell, profile selection, `--resume`/`--takeover`, fullscreen.
- `packages/tui/src/ui/WorkspaceShell.tsx` — switches between the local runtime and workspace runtimes (`packages/tui/src/core/RemoteRuntime.ts`, a `TuiRuntime` over `@marifold/client`).
- `packages/tui/src/ui/App.tsx` — the controller: `appReducer` state, session lease renewal (`renewSessionLease`), and the hooks `packages/tui/src/ui/useRuns.ts` (agent/chat runs, steering, retry, cancel), `packages/tui/src/ui/useApprovals.ts` (approval and question prompts, session "Always" grants), `packages/tui/src/ui/useSkills.ts` (`$skill` binding and runs).
- Pure, unit-tested core in `packages/tui/src/core/`: `inputGrammar.ts`, `eventView.ts` (`agentEventToItems`), `appState.ts` (`appReducer`, `applyAgentEvent`), `commands.ts` (slash commands), `promptHistory.ts`, `TuiRuntime.ts` (the runtime surface the UI needs).
- Thin Ink components in `packages/tui/src/ui/` (`Transcript.tsx`, `InputBox.tsx`, `ApprovalModal.tsx`, `QuestionModal.tsx`, `StatusLine.tsx`, `FullScreen.tsx`, ...).

Tests: `packages/tui/tests/` (`core.test.ts`, `app.test.tsx`, `AppRuns.test.tsx`, `RemoteRuntime.test.ts`).
