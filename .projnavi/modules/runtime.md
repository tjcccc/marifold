# Runtime Module

`MarifoldRuntime` (`packages/core/src/runtime/MarifoldRuntime.ts`) is the thin product layer over `@priest-ai/core`: it resolves config/profile/session settings, selects profile memory, owns the stores, and exposes the management surface every client calls. Since 2026-10-09 the heavy paths live in collaborators it wires through closures (so test spies on the runtime still apply).

Use this note for: ask/stream chat turns, the chat tool loop, agent runner wiring, the default tool registry, SkillApp operation execution, session leases, scheduling/run-registry/Telegram entry points, or provider engine setup.

- `packages/core/src/runtime/ChatTurns.ts` — `ask()` and `stream()` chat turns through `PriestEngine`: environment context, profile memory, hosted-search versus fallback resolution, the bounded caller-executed tool loop (`chatTools()`: `web_search`/`read_web_page` in fallback mode, `read_file` when read approval is `allow`; at most 3 iterations), hosted-search capability fallback, session persistence and edits, and `applyTurnMemory`. Ordinary messages use agent runs; this path serves chat-mode Skills and compatibility clients.
- `packages/core/src/runtime/ProviderEngines.ts` — engine creation, OAuth `refreshCredentials`, `priestConfig`, and think support (see `.projnavi/modules/providers.md`).
- `packages/core/src/runtime/SkillAppOperations.ts` — runs one SkillApp v1/v2 operation through the engines or an isolated read-only agent run (`runProfileAgent`).
- `MarifoldRuntime` methods: `resolveSettings`, `resolveAgentConfigForProfile`, `createAgentRunner()` (engine factory, TaskStore, session hold, persisted turn pairs, built-in guides, read-only skill roots), `createDefaultToolRegistry()`, `createHostContextTools()`, skill and App catalog methods, `runSkillAppOperation`, `createScheduler()`/`runScheduleUnattended()`, `createRunRegistry()`, `createTelegramBridge()`, and session lease methods `acquireSession`/`takeOverSession`/`releaseSession`/`assertSessionAvailable` over `packages/core/src/sessions/SessionLeases.ts`. Private `resolveWebSearch` picks `native`/`fallback`/`unavailable`.
- `packages/core/src/runtime/MarifoldTypes.ts` (request/response types), `RuntimeEnvironment.ts` (client interface/timezone context), `NativeWebSearch.ts` (hosted-search capability errors).

Tests: `packages/core/tests/MarifoldRuntime.test.ts`, `packages/core/tests/ChatParity.test.ts`, `packages/core/tests/Compaction.test.ts`, `packages/core/tests/RuntimeEnvironment.test.ts`.
