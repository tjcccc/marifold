# SkillApp Module

Schema + validator only (no runtime yet) for `marifold.skillapp.v0` mini-app definitions.

Use this note for: the SkillApp TOML schema, validation rules, or the permission vocabulary.

- `skillapp/SkillAppSchema.ts` — types: app/variables/layout/actions/permissions; `SKILLAPP_SCHEMA = 'marifold.skillapp.v0'`; closed component + tool sets.
- `skillapp/SkillAppValidator.ts` — `validateSkillAppToml` / `validateSkillApp`: schema id, kebab/snake names, enum options, layout binds, action kinds, permission gates (aligned with agent `ToolKind`/`ApprovalMode`).
- Spec: `docs/skillapp.md`. No renderer until a client UI exists.
