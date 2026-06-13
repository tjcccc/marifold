# Runtime Module

`MarifoldRuntime` (`packages/core/src/runtime/MarifoldRuntime.ts`) is the thin product layer over `@priest-ai/core`. It resolves config/profile/session settings and delegates ask/stream to PriestEngine.

Use this note for: ask/stream behavior, the chat tool loop, agent runner wiring, scheduling entry points, or credential refresh.

- `ask()` / `stream()` — resolve settings, select profile memory, run through PriestEngine; `stream()` runs a bounded chat tool loop when `[web_search].enabled` (web_search/read_file as model tools), applying memory payloads only on the final response.
- `createAgentRunner()` — wires AgentRunner with the default ToolRegistry, TaskStore, and `[agent]` policy.
- `createScheduler()` / `runScheduleUnattended()` — scheduled agent runs (tagged `scheduled`, unattended approval).
- `refreshProviderCredentialsIfNeeded()` — per-provider OAuth refresh dispatch (Copilot + ChatGPT).
- `chatTools()` — assembles model-initiated chat tools under `[web_search]`/approval policy.
- Types in `runtime/MarifoldTypes.ts`.
