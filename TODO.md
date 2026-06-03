# TODO

## Near-Term CLI Commands

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
- Agent runtime: tool-call policy, permission boundaries, and external tool execution after the chat foundation is stable.

## Notes

- v0.7.x includes the TypeScript CLI foundation plus controlled profile memory, thinking-mode, model-validation commands, OAuth provider setup, Copilot Responses API routing, and command smoke coverage.
- Defer broad automatic memory extraction, `/search`, image, `service`, Web UI, provider-owned model deletion, and agentic tool loops until the non-agent chat and session surfaces are predictable.
- Marifold can remove saved model references from its config, but should not delete actual local provider model files such as Ollama blobs.
