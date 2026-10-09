# CLI Module

The `marifold` package (`packages/cli`): commander commands and terminal output. `packages/cli/src/index.ts` registers every command and, for a bare `marifold`, loads the ESM TUI (`@marifold/tui`) through a dynamic `import()` escape hatch.

Use this note for: command surface and flags, the bare-`marifold` TUI launch (`--resume`, `--takeover`, `--fullscreen`), OAuth sign-in prompts, or service process management.

- `packages/cli/src/commands/`: `init.ts`, `agent.ts` (renders the `AgentEvent` stream with a readline `ApprovalHandler`), `ask.ts`, `channel.ts` (Telegram setup), `config.ts` (show/set/get/export/import/search), `doctor.ts`, `model.ts`, `profile.ts`, `provider.ts` (list/add/reauth/status), `schedule.ts`, `service.ts` (start with optional `--daemon`, stop, restart), `session.ts`, `status.ts`, `update.ts`, `workspace.ts` (bridge/prepare/create/add/executor/list/remove/rename/default/revoke), `execution.ts` (device execution mode, jobs, Tailscale).
- `packages/cli/src/commands/chat.ts` defines `registerChatCommand` but `index.ts` no longer registers it (since v0.69.0); ordinary messages go through the TUI's agent path.
- `packages/cli/src/commands/RuntimeFactory.ts` builds the `MarifoldRuntime`/loaded config from `--config`; `WorkspaceClient.ts` talks to the local service for workspace commands.
- `packages/cli/src/auth/`: `ChatGptAuth.ts`, `GitHubCopilotAuth.ts`, `XaiAuth.ts` (interactive OAuth), driven from `packages/cli/src/input/ModelPicker.ts` (model add, provider reauth).
- `packages/cli/src/service/ServiceProcess.ts` + `ServiceOutput.ts` — single-instance service process state under `~/.marifold/service/`.
- `packages/cli/src/input/` (prompts, `TerminalSelect.ts`, `SecretPrompt.ts`) and `packages/cli/src/output/` (`ConsolePrinter.ts`, `TerminalStyle.ts`, `inert.ts` strips terminal control sequences).

Tests live in `packages/cli/tests/` (e.g. `ServiceLifecycle.test.ts`, `ModelPicker.test.ts`, `VersionConsistency.test.ts`).
