# Skills Module

`marifold.skill.v0` prompt templates (`$name` invocations) in `packages/core/src/skill/`. Design: `docs/architecture.md` (skill subsystem) and `docs/tui.md`.

Use this note for: skill files and validation, `$skill` invocation binding, profile versus global skill scope, built-in skills (`$skill-installer`, `$skill-creator`, `$skillapp-builder`), or the `manage_skill` tool.

- `packages/core/src/skill/SkillSchema.ts` — `SKILL_SCHEMA_ID`, `MarifoldSkill`, variables, run mode (`agent`/`chat`). `SkillValidator.ts` (`parseSkill`) and `SkillTemplater.ts` (`renderSkillPrompt`) validate and expand them.
- `packages/core/src/skill/SkillStore.ts` — global `[paths].skills_dir` plus each profile's `skills/` directory; profile skills shadow global ones.
- `packages/core/src/skill/SkillInvocation.ts` — `parseSkillInvocation`, `bindSkillArgs`, `resolveSkillInvocation` (exactly one skill resolved before model execution).
- `packages/core/src/skill/BuiltInSkills.ts` + `BuiltInSkillManager.ts` — protected compiled built-ins and the guide injected for skill-management objectives; `packages/core/src/agent/tools/SkillManagementTool.ts` is the approval-aware `manage_skill` tool.
- Runtime: `MarifoldRuntime.createSkillStore`/`listSkills`/`resolveSkillInvocation`. Clients: TUI `packages/tui/src/ui/useSkills.ts`; service `POST /v1/skills/resolve` in `packages/service/src/SkillAppRoutes.ts`.

Tests: `packages/core/tests/Skill.test.ts`.
