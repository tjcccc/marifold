# CLAUDE.md

Project memory for Claude Code. Kept thin on purpose — this loads every turn.

## Authoritative docs (read for design; don't restate them)

- `AGENTS.md` — stack, package boundaries, validation gates.
- `docs/architecture.md` — dependency direction and module responsibilities.
- `docs/roadmap.md` / `docs/vision.md` — direction and milestone history.
- `DEVLOG.md` — newest-first change log.

<!-- projnavi-agent-claude-policy:start -->
## projnavi

Before broad or ambiguous codebase work, run `projnavi guide "<task>"` and use the result as navigation advice only — then verify the named files and line ranges before editing. Use the `/projnavi` skill for `onboard` and `benchmark` workflows.

`projnavi guide` is strongest for high-entropy tasks such as cross-layer changes, project-specific concepts, architecture-sensitive edits, provider integrations, scattered ownership, or unclear naming. Skip it for trivial single-file edits where the exact location is already known; plain `rg` is fine there. Use `--max-items <n>` to cap only the `Read first` list.

Maintenance is bounded: after changing files referenced by `.projnavi/claims.jsonl`, `.projnavi/glossary.json`, or `.projnavi` notes, run `projnavi onboard` then `projnavi verify` — not continuously.
<!-- projnavi-agent-claude-policy:end -->
