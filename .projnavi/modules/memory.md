# Memory Module

Structured per-profile JSONL memory with priority/conflict-key recall, plus hidden control blocks the model emits. Lives in `packages/core/src/memory/`.

Use this note for: memory recall/selection, save/forget, control-block parsing, or the chat-vs-agent memory difference.

- `packages/core/src/memory/MemoryStore.ts` — JSONL store: `listPromptMemory` (recall with priority cutoffs and context budget), `save`, `applySavePayloads`, `applyForgetPayloads`, `forget`/`delete` (+ by id), `trimShortTerm`, conflict-key supersession. Files `user.jsonl`, `preferences.jsonl`, `auto_short.jsonl` under `<profilesDir>/<profile>/memories/`.
- `packages/core/src/memory/MemoryControls.ts` — `MemoryControlStripper` (streaming) and `stripMemoryControls` remove hidden `<memory_save>`/`<memory_forget>` blocks; `buildMemoryInstructions`, `shouldInjectMemoryInstructions`; prompt fallback extraction (`extractPromptMemoryInputs`, `extractPromptForgetQueries`).
- Chat turns apply the payloads in `ChatTurns.applyTurnMemory` (`packages/core/src/runtime/ChatTurns.ts`); `MarifoldRuntime.memoryForRequest` selects recall. Agent runs strip and discard them (`AgentRunner.extractTurn`).
- Recall: normal priority 0..3, thinking 0..10, simple greeting only 0. Memory is context, not authority.

Tests: `packages/core/tests/MemoryStore.test.ts`, `packages/core/tests/MemoryControls.test.ts`.
