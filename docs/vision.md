# Vision

Marifold is a local-first personal AI workspace for everyday AI work, profile-based continuity, skill apps, and multi-agent composition.

Marifold should not try to become another all-round heavyweight agent like Codex, Claude Code, or other mainstream agent apps. Those tools will keep becoming more capable, and a single-developer project should not compete with them on raw agent power. Marifold should instead make smaller, repeated, personal AI tasks lighter and better organized, then call stronger external agents when the task actually needs them.

## Product Position

Marifold is the personal coordinator around AI work:

- Native profiles handle lightweight chat, ask, memory, provider routing, and focused skills.
- Skill apps provide small GUI surfaces for repeatable tasks.
- Workflows compose profiles, skills, models, and external agents.
- External-agent aliases delegate heavyweight work to tools such as Codex or Claude Code.

The goal is not to replace powerful agents. The goal is to know when a simple profile is enough and when to call the right worker.

## Core Concepts

Profiles are the main unit of identity and continuity. A profile can have its own model, provider, memory, style, sessions, tools, and future UI.

Native profiles talk directly to configured model providers.

Alias profiles point to external agents or commands, such as Codex or Claude Code. They allow Marifold to launch, wrap, delegate to, or compose with tools that are already strong at specialized tasks.

Skills are reusable capabilities. A skill should not only be a prompt; it can become a structured interface with inputs, variables, actions, and outputs.

Apps are GUI surfaces generated from safe schemas. Marifold owns rendering, validation, permissions, state, result normalization, and provider calls instead of executing definition files as arbitrary code.

Workflows connect profiles, Skills, Apps, models, and external agents into multi-step jobs.

## App Shape

The current `marifold.skillapp.v1` template contract defines a safe floor that can grow to include:

- Layout: known UI components such as text inputs, text areas, selects, tabs, preview panes, file pickers, and download buttons.
- State: user-editable bindings and server-owned generated outputs.
- Operations: one app-local Skill run with one explicitly registered model and a declared result shape.
- Triggers: direct button bindings and debounced state-change bindings with service-owned concurrency.

Example targets:

- Translator: language selectors, input, translated output, copy/export commands.
- UI design app: prompt input, rendered preview, HTML/CSS viewers, and downloader.
- Research helper: query input, source list, notes panel, and summary output.
- Image prompt app: structured controls, generated prompt, and optional image preview.

## Design Principles

- Stay local-first for user data, profiles, memory, sessions, and app definitions.
- Keep everyday use lightweight and fast.
- Prefer focused, repeatable task surfaces over generic agent magic.
- Preserve clear user control over memory, tools, files, network access, and external delegation.
- Let the right model or agent do the right work.
- Build from real daily use rather than trying to match every mainstream agent feature.
