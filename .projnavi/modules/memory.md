# Memory Module

Structured per-profile JSONL memory with priority/conflict-key recall, plus hidden control blocks the model emits.

Use this note for: memory recall/selection, save/forget, control-block parsing, or the chat-vs-agent memory difference.

- `memory/MemoryStore.ts` — JSONL store: `listPromptMemory` (recall with priority cutoffs/context budget), `applySavePayloads`, `forget`, `trimShortTerm`, conflict-key supersession. Files: `user.jsonl`, `preferences.jsonl`, `auto_short.jsonl` under each profile.
- `memory/MemoryControls.ts` — `stripMemoryControls` / `MemoryControlStripper` remove hidden `<memory_save>`/`<memory_forget>` blocks from output; `buildMemoryInstructions`; prompt-fallback extraction. **Chat applies these payloads; agent runs strip and discard them.**
- Recall: normal 0..3, thinking 0..10, simple greeting only 0. Memory is context, not authority.
