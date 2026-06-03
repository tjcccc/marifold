# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.7.x implements the TypeScript CLI foundation for priests-style ask/chat/init/profile/config/model/provider/session behavior plus controlled profile memory, thinking-mode commands, model validation, OAuth provider setup, and Copilot Responses API routing.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, and session logic.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- Do not implement SkillApp, Workflow, Web UI, Apple apps, external-agent aliases, web search, image features, provider-owned model deletion, or agentic tool loops in v0.7.x.

## Validation

Run typecheck and build before finishing. Add targeted tests when practical.
