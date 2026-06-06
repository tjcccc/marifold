# TODO

## Current Plan

- v0.9.0: structured memory system upgrade. See [docs/roadmap.md](docs/roadmap.md).
- Next: decide when to introduce ephemeral task memory for future agent loops.

## Completed in v0.8.0

- `model rm <provider/model>`: remove a saved Marifold model option from `[models].options`; do not delete provider-owned model files.
- `model validate --all`: validate every saved model option plus global/profile defaults.
- `config export <file>` / `config import <file>`: backup and restore local config, profiles, memories, and optional sessions.
- `profile rename <from> <to>` and `profile delete <name>`: local profile management with safe confirmations.
- `session clear`: bulk session cleanup with filters such as `--profile`, `--before`, `--keep-last`, and `--yes`.

## Completed in v0.9.0

- Structured profile memory now stores priority, confidence, stability, source, source type, scope, timestamps, evidence, reason, conflict keys, and supersession status.
- Memory recall now uses priority cutoffs, prompt relevance ranking, simple-prompt gating, thinking-mode expansion, expiry checks, and context budgeting.
- Prompt fallback now captures explicit names, favorite/preferred facts, response-style preferences, meeting times, and prompt-driven forget requests.
- Conflict-key handling now canonicalizes aliases, rejects generic slots, infers common slots, and supersedes older active records.
- `[memory].size_limit` now trims low-priority `auto_short.jsonl` entries.
- `profile memory` lists active or all profile memory records.
- `scripts/memory-eval.mjs` runs provider-backed chat memory checks after `pnpm build`.

## Future Agent-App Core Features

- Ephemeral task memory: current objective, plan, progress, observations, decisions, blockers, and next action for future agent loops.
- Memory expansion: workspace/project scopes, used-memory tracing, semantic retrieval, memory edit UI, optional encryption, and richer redaction.
- Web search: future `/search <query>` chat command plus model-requested search hooks.
- Image paste/upload: terminal image attachment workflow and provider request plumbing.
- OAuth refresh: refresh expired ChatGPT credentials before provider requests, matching priests.
- Service API: future `service` CLI plus local HTTP service for chat, profiles, sessions, config, providers, and assets.
- Web UI: browser chat app backed by the service API.
- SkillApp runtime: schema-defined GUI mini apps for focused skills such as translators, UI design helpers, research helpers, and prompt generators.
- Alias profiles: profile entries that launch, wrap, delegate to, or compose with external agents such as Codex and Claude Code.
- Workflow composition: route subtasks across native profiles, skill apps, models, and external-agent aliases.
- Agent runtime: tool-call policy, permission boundaries, and external tool execution after the chat foundation is stable.

## Product Outlook

- Marifold should be a lightweight local-first personal AI workspace, not a direct competitor to heavyweight all-round agents.
- Heavy coding and complex autonomous work can be delegated to external-agent aliases when tools such as Codex or Claude Code are a better fit.
- The core user value is profile-based continuity, memory, focused skill apps, and choosing the right model or agent for each task.
- See [docs/vision.md](docs/vision.md) for the fuller product direction.

## Notes

- v0.9.x includes the TypeScript CLI foundation plus upgraded structured profile memory, thinking-mode, model-validation commands, OAuth provider setup, Copilot Responses API routing, config backup/import, saved-model removal, profile rename/delete, bulk session clearing, and command/memory eval coverage.
- Defer `/search`, image, `service`, Web UI, provider-owned model deletion, and agentic tool loops until the non-agent chat, session, and memory surfaces are predictable.
- Marifold can remove saved model references from its config, but should not delete actual local provider model files such as Ollama blobs.
