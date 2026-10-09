# Agent Module

Approval-aware agent loop in `packages/core/src/agent/`, shared by every client (TUI, CLI, Web via the service, Telegram, schedules, SkillApp profile operations). Design: `docs/architecture.md` (Core subsystems, Trust boundaries).

Use this note for: the agent run lifecycle, tools and the tool registry, approval policy, the run workspace sandbox, the event contract, or the control-block fallback.

- `packages/core/src/agent/AgentRunner.ts` — `run(options)` AsyncGenerator: holds the session lease for the run, optional plan, approval-aware tool loop, final outcome recorded in TaskStore, one clean user→assistant pair persisted per run. Strips and discards memory control blocks (`extractTurn`); there is no separate model self-grade. Switches to control-block mode via `shouldFallBackToControlBlocks` and to Marifold fallback search when hosted search is rejected.
- `packages/core/src/agent/AgentEvents.ts` — the renderer-agnostic `AgentEvent` union (see `.projnavi/flows/agent-event-contract.md`).
- `packages/core/src/agent/ApprovalPolicy.ts` — `ToolKind`, `ApprovalMode`, `DEFAULT_AGENT_CONFIG`, `resolveAgentConfig`, `ApprovalRequest`, and the `ApprovalHandler` callback. Without a handler (unattended) `ask` degrades to deny; `[agent.unattended]` overrides merge over approval for unattended runs.
- `packages/core/src/agent/ToolRegistry.ts` — `AgentTool` interface (`definition`, `kind`, `summarizeCall`, optional `assessRisk`, `execute`), `AgentToolKind` (adds `interaction`), `ToolRegistry`, `capToolOutput`.
- `packages/core/src/agent/tools/` — `AskUserTool` (`ask_user`), `InspectAttachmentTool`/`ReadAttachmentTool`/`SearchAttachmentTool`, `ReadFileTool`, `WriteFileTool`, `ShellExecTool`, `SudoExecTool`, `ShellJobStatusTool`, `PythonPackageTool` (`python_package_install`), `SkillManagementTool` (`manage_skill`), `SkillAppTools` (`inspect_skill_apps`, `manage_skill_app`), `WebSearchTool`, `ReadWebPageTool`, `DelegateTool` (`ask_profile`). Workspace tools `delegate_device` and `list_devices` live in `packages/core/src/workspace/`.
- `packages/core/src/agent/RunWorkspace.ts` + `ScopedProcess.ts` — per-run capability roots under `~/.marifold/runs/<run-id>/`, path resolution (`resolveToolPath`), and the platform sandbox for shell; `AttachmentResources.ts`, `RunArtifacts.ts`, `ArtifactPreview.ts` handle attachments and artifacts.
- `packages/core/src/agent/DeviceExecution.ts` + `DeviceExecutionWorker.ts` + `SudoCredentials.ts` — full-access and `sudo_exec` jobs run by detached workers (`docs/device-execution.md`).
- `packages/core/src/agent/UserInput.ts` — validated `ask_user` question requests and answers.
- `packages/core/src/agent/ControlBlockTools.ts` — prompt-embedded `<tool_call>` fallback for models without native tool calling.

The runner is wired by `MarifoldRuntime.createAgentRunner()` and the default tool set by `MarifoldRuntime.createDefaultToolRegistry()` (`packages/core/src/runtime/MarifoldRuntime.ts`). Tests: `packages/core/tests/AgentRunner.test.ts`, `packages/core/tests/AgentTools.test.ts`, `packages/core/tests/RunWorkspace.test.ts`.
