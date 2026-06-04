# Roadmap

This roadmap captures the current product direction after the v0.7.0 priests migration work.

## v0.8.0 - CLI and Profile Management Polish

Goal: make Marifold feel complete as a local management CLI before adding larger agent surfaces.

Planned scope:

- Remove saved model options without deleting provider-owned model files.
- Validate all saved/default/profile models.
- Rename and delete local profiles with safe confirmations.
- Export and import local config, profiles, memories, and optional sessions.
- Clear sessions in bulk with profile/date/keep-last filters.
- Expand repeatable non-network command smoke coverage.

## v0.9.0 - Memory System Upgrade

Goal: make memory more trustworthy and inspectable.

Planned discussion topics:

- What memory kinds Marifold should support.
- How model-driven memory extraction should work.
- How users inspect, edit, approve, forget, and delete memories.
- How conflict keys, deduplication, and cleanup should behave.
- How memory differs between native profiles, skill apps, workflows, and alias profiles.

## Later

- Main `marifold` TUI as the primary entrypoint.
- Service API and Web UI foundation.
- Schema-defined SkillApp runtime.
- Alias profiles for Codex, Claude Code, and other external agents.
- Workflow composition across native profiles, skill apps, models, and external-agent aliases.
