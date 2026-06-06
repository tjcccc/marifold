# Roadmap

This roadmap captures the current product direction after the v0.7.0 priests migration work.

## v0.8.0 - CLI and Profile Management Polish

Goal: make Marifold feel complete as a local management CLI before adding larger agent surfaces.

Planned scope:

- Remove saved model options without deleting provider-owned model files.
- Validate all saved/default/profile models.
- Rename and delete local profiles with safe confirmations.
- Export and import local config, profiles, memories, and optional sessions.
- Clear sessions in bulk with profile/date/keep-last filters.
- Expand repeatable non-network command smoke coverage.

## v0.9.0 - Memory System Upgrade

Goal: make memory more trustworthy, inspectable, and ready for future agent/task state without implementing the agent loop yet.

Implemented scope:

- Structured profile memory with rich JSONL metadata.
- Priority/relevance recall, simple-prompt gating, thinking-mode priority expansion, and context budgeting.
- Model-driven hidden memory saves/forgets plus conservative prompt fallback extraction.
- Conflict-key canonicalization, deduplication, supersession, prompt-driven forget, and permanent delete.
- Short-term memory trimming through `[memory].size_limit`.
- CLI memory inspection through `profile memory`.
- Deterministic tests and provider-backed `scripts/memory-eval.mjs`.

Deferred discussion:

- Dedicated ephemeral task memory for future agent loops.
- Workspace/project memory scopes beyond profile memory.
- Memory edit UI, semantic retrieval, encryption, and used-memory tracing.

## Later

- Main `marifold` TUI as the primary entrypoint.
- Service API and Web UI foundation.
- Schema-defined SkillApp runtime.
- Alias profiles for Codex, Claude Code, and other external agents.
- Workflow composition across native profiles, skill apps, models, and external-agent aliases.
