# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.10.x implements the TypeScript CLI foundation plus upgraded priests-style structured profile memory, a loopback-only Fastify service API, and an ephemeral task-state foundation for future agent loops.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation
- Fastify for the local HTTP service

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, memory, task-state, and session logic.
- `packages/service` contains the loopback-only Fastify API. Keep it as a thin transport layer over `packages/core`.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- Do not implement SkillApp, Workflow, Web UI, Apple apps, external-agent aliases, web search, image features, provider-owned model deletion, or agentic tool loops until that area is explicitly in scope.

## Validation

Run typecheck and build before finishing. Add targeted tests when practical.
