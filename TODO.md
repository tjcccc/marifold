# TODO

## Future Agent-App Core Features

- Memory: profile-scoped durable facts, preferences, short-term notes, and memory commands.
- Web search: explicit chat search command plus model-requested search hooks.
- Image paste/upload: terminal image attachment workflow and provider request plumbing.
- Service API: local HTTP service for chat, profiles, sessions, config, providers, and assets.
- Web UI: browser chat app backed by the service API.
- Agent runtime: tool-call policy, permission boundaries, and external tool execution after the chat foundation is stable.

## Notes

- Keep v0.1.x focused on the TypeScript CLI foundation: ask, chat, init, profile, config, model, provider, and session commands.
- Defer memory/search/image/service/web UI until the non-agent chat and session surfaces are predictable.
