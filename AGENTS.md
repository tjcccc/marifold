# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.1.0 implements the TypeScript CLI foundation for priests-style ask/chat/init/profile/config/model/provider/session behavior.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, and session logic.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- Do not implement SkillApp, Workflow, Web UI, Apple apps, external-agent aliases, memory/search/image features, or agentic tool loops in v0.1.0.

## Validation

Run typecheck and build before finishing. Add targeted tests when practical.
