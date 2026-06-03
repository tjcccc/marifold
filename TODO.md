# TODO

## Future Agent-App Core Features

- Memory expansion: automatic model-driven extraction, conflict-key consolidation, richer policies, and disk-size trimming.
- Web search: explicit chat search command plus model-requested search hooks.
- Image paste/upload: terminal image attachment workflow and provider request plumbing.
- Service API: local HTTP service for chat, profiles, sessions, config, providers, and assets.
- Web UI: browser chat app backed by the service API.
- Agent runtime: tool-call policy, permission boundaries, and external tool execution after the chat foundation is stable.

## Notes

- v0.4.x includes the TypeScript CLI foundation plus controlled profile memory commands.
- Defer automatic memory extraction, search, image, service, and Web UI until the non-agent chat and session surfaces are predictable.
