# TODO

## Current Plan

- v0.8.0: CLI and profile management polish. See [docs/roadmap.md](docs/roadmap.md).
- v0.9.0: memory system upgrade discussion and implementation plan.

## Completed in v0.8.0

- `model rm <provider/model>`: remove a saved Marifold model option from `[models].options`; do not delete provider-owned model files.
- `model validate --all`: validate every saved model option plus global/profile defaults.
- `config export <file>` / `config import <file>`: backup and restore local config, profiles, memories, and optional sessions.
- `profile rename <from> <to>` and `profile delete <name>`: local profile management with safe confirmations.
- `session clear`: bulk session cleanup with filters such as `--profile`, `--before`, `--keep-last`, and `--yes`.

## Future Agent-App Core Features

- Memory expansion: broad automatic extraction beyond current model blocks/name fallback, richer conflict-key consolidation, stronger policies, and disk-size trimming.
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

- v0.8.x includes the TypeScript CLI foundation plus controlled profile memory, thinking-mode, model-validation commands, OAuth provider setup, Copilot Responses API routing, config backup/import, saved-model removal, profile rename/delete, bulk session clearing, and command smoke coverage.
- Defer broad automatic memory extraction, `/search`, image, `service`, Web UI, provider-owned model deletion, and agentic tool loops until the non-agent chat and session surfaces are predictable.
- Marifold can remove saved model references from its config, but should not delete actual local provider model files such as Ollama blobs.
