# AGENTS

## Project

Marifold is a local-first personal AI workspace for profiles, chats, skills, mini apps, workflows, and external agents.

v0.9.x implements the TypeScript CLI foundation plus upgraded priests-style structured profile memory: priority/relevance recall, richer JSONL metadata, conflict-key updates, prompt fallback extraction, short-term trimming, memory inspection, and memory eval coverage.

## Stack

- TypeScript
- pnpm workspace
- Node.js
- `@priest-ai/core` as the chat/runtime foundation

## Boundaries

- `packages/core` contains runtime, workspace, config, profile, and session logic.
- `packages/cli` contains terminal commands and interactive CLI behavior.
- Do not implement SkillApp, Workflow, Web UI, Apple apps, external-agent aliases, web search, image features, provider-owned model deletion, or agentic tool loops until that area is explicitly in scope.

## Validation

Run typecheck and build before finishing. Add targeted tests when practical.
