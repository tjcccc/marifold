# CLI Module

Commander commands + interactive terminal UI. `packages/cli/src/index.ts` registers all commands.

Use this note for: command surface, flags, interactive chat/agent rendering, or OAuth prompts.

- `commands/`: `agent.ts` (renders the AgentEvent stream + readline ApprovalHandler), `chat.ts` (streaming chat, `/search` `/read` `/image` `/remember` `/think`), `ask.ts`, `schedule.ts`, `model.ts`, `provider.ts`, `profile.ts`, `session.ts`, `config.ts`, `init.ts`, `service.ts`.
- `auth/`: `ChatGptAuth.ts`, `GitHubCopilotAuth.ts` (interactive OAuth).
- `input/InteractivePrompt.ts`, `output/ConsolePrinter.ts`, `output/TerminalStyle.ts`.
- `RuntimeFactory.ts` builds the MarifoldRuntime from `--config`.
