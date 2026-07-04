# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.35.x implements the TypeScript CLI + TUI foundation, priests-style structured profile memory, an approval-aware agent loop (native tool calling plus a control-block fallback), chat tool parity (web search, file reading, images), markdown skills, scheduled unattended runs, the Telegram channel, and a loopback-only Fastify service API with optional bearer auth, a CORS origin allowlist, and live agent-run routes (SSE `AgentEvent` stream, approval/steer/cancel POSTs) documented in `docs/service-api.md`.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation
- Fastify for the local HTTP service

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, memory, agent (runner/tools/approval), task-state, and session logic.
- `packages/service` contains the loopback-only Fastify API. Keep it as a thin transport layer over `packages/core`.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- `@priest-ai/core` (../priest-typescript) owns model-side primitives: providers, tool-call transport, streaming, context assembly. Changes there must be synced to the priest spec repository.
- The `AgentEvent` union in `packages/core/src/agent/AgentEvents.ts` is the render contract for all future clients; keep it renderer-agnostic.
- Agent runs must not write profile memory; task state stays ephemeral.
- Service-layer Web UI prep (agent-run routes, auth, CORS, the `docs/service-api.md` contract) is in scope; the browser UI itself (`apps/web`) is not yet. Do not implement SkillApp runtime/rendering, Workflow, Apple apps, external-agent aliases, or provider-owned model deletion until that area is explicitly in scope.

## Validation

Run typecheck and build before finishing. Add targeted tests when practical.
