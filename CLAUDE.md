# CLAUDE.md

Project memory for Claude Code. Kept thin on purpose — this loads every turn.

## Authoritative docs (read for design; don't restate them)

- `AGENTS.md` — stack, package boundaries, validation gates.
- `docs/architecture.md` — dependency direction and module responsibilities.
- `docs/roadmap.md` / `docs/vision.md` — direction and milestone history.
- `DEVLOG.md` — newest-first change log.

## projnavi (navigation layer)

Before broad or ambiguous codebase work, run `projnavi guide "<task>"` and use the
result as a starting map — then verify the named files/line-ranges before editing.
projnavi is strongest for high-entropy work (cross-layer changes, the AgentEvent
contract, provider routing, memory/approval seams, scattered ownership). Skip it for
trivial single-file edits where the exact location is already known; plain `rg` is fine there.

Maintenance is bounded: refresh `.projnavi` (run `projnavi onboard` then `projnavi verify`,
update claims/notes/glossary) only at savegame/release boundaries or after changing files
that back existing claims — not continuously.
