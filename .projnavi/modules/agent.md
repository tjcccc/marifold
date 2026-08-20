# Agent Module

Approval-aware agent loop. Lives in `packages/core/src/agent/` so every client reuses it.

Use this note for: the agent run lifecycle, tools, approval policy, the event contract, or the control-block fallback.

- `AgentRunner.ts` — `run(options)` AsyncGenerator: optional plan -> approval-aware tool loop -> final outcome, persisting progress to TaskStore. Agent runs bypass the chat memory pipeline (strip + discard memory control blocks). Focused observable checks run through ordinary tools; there is no separate model self-grade.
- `AgentEvents.ts` — the renderer-agnostic `AgentEvent` union consumed by CLI, TUI, Web, service SSE, and future clients. Keep it free of renderer formatting.
- `ApprovalPolicy.ts` — `ToolKind`, `ApprovalMode`, `ApprovalHandler` callback, `MarifoldAgentConfig`, `resolveAgentConfig`. `ask` degrades to deny on unattended runs; `[agent.unattended]` overrides widen it.
- `ToolRegistry.ts` — `AgentTool` interface (`definition`, `kind`, `summarizeCall`, `assessRisk`, `execute`) + registry.
- `ControlBlockTools.ts` — prompt-based `<tool_call>` fallback for models without native tool calling; parsed like memory control blocks.
- `tools/` — `AskUserTool`, `ReadFileTool`, `WriteFileTool` (workspace jail + `~` expansion), `ShellExecTool`, `PythonPackageTool`, `DelegateTool` (ask_profile), `WebSearchTool`.

The runner is wired by `MarifoldRuntime.createAgentRunner()`; the CLI surface is `packages/cli/src/commands/agent.ts`.
