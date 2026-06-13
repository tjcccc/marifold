# Flow: add a new agent tool

A representative cross-layer change.

1. Implement `AgentTool` in `packages/core/src/agent/tools/<Name>Tool.ts` (`definition` with JSON-schema params, `kind: ToolKind`, `summarizeCall`, optional `assessRisk`, `execute`). Expand `~` in path args via `workspace/WorkspacePaths` `expandHome`.
2. If it is a new risk class, add a `ToolKind` in `agent/ApprovalPolicy.ts` and a default `ApprovalMode` in `DEFAULT_AGENT_CONFIG`, plus `[agent.approval]` parsing in `config/ConfigLoader.ts` `normalizeAgent` and rendering in `config/ConfigManager.ts`.
3. Register it in `MarifoldRuntime.createDefaultToolRegistry()` (runtime/MarifoldRuntime.ts).
4. For chat reuse, expose it in `MarifoldRuntime.chatTools()`.
5. Tests: add to `packages/core/tests/AgentTools.test.ts`; the loop is covered by `AgentRunner.test.ts`.
6. Control-block fallback works automatically (definitions are rendered into the prompt by `agent/ControlBlockTools.ts`).
