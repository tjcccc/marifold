# SkillApp (App) Module

Statically compiled mini-app templates in `packages/core/src/app/`. A bundle is `<apps_dir>/<name>/skillapp.ts` written in a restricted TypeScript DSL; marifold parses it as an AST (never imports or executes it) and compiles it to a renderer-neutral `SkillAppDefinition`. Spec: `docs/app.md`; boundary: `docs/architecture.md` and `AGENTS.md`.

Use this note for: SkillApp templates and schemas (`marifold.skillapp.v1`/`.v2`), compiling and validation, App instances and triggers, running an App operation, the SkillApp builder tools, or the Web Apps screen.

- `packages/core/src/app/SkillAppSchema.ts` — `SKILL_APP_SCHEMA` (v1, profile-free: app-local Skill + explicit model) and `SKILL_APP_PROFILE_SCHEMA` (v2: registered profile + profile Skill); definition, component, permission, result, and instance snapshot types.
- `packages/core/src/app/SkillAppDsl.ts` — authoring helpers (`defineSkillApp`, `State`, `AttachmentState`, `FileAccess`/`FolderAccess`, `registerModel`, `registerProfile`, `useSkill`/`useProfileSkill`, `trigger`, components).
- `packages/core/src/app/SkillAppCompiler.ts` — `compileSkillApp(source)`: AST inspection and evaluation into a definition; `SkillAppCompilerSupport.ts` holds the compile state and AST/value checks, `SkillAppValidation.ts` the whole-template reference, permission, and model-id validation.
- `packages/core/src/app/AppStore.ts` — lists/loads bundles from the apps directory and resolves their Skills (v2 via `resolveProfileSkill`); `SkillAppResolver.ts` resolves one operation and its Skill invocation from form state.
- `packages/core/src/app/SkillAppInstanceRegistry.ts` — ephemeral service-owned instances: state, debounced latest-wins triggers, attachments, executions, interaction (question/approval) handlers.
- `packages/core/src/runtime/SkillAppOperations.ts` — executes an operation (`MarifoldRuntime.runSkillAppOperation`) through the provider engines or an isolated read-only agent run.
- Builder: `packages/core/src/agent/tools/SkillAppTools.ts` (`inspect_skill_apps`, approve-once `manage_skill_app`) and `packages/core/src/skill/BuiltInSkillAppBuilder.ts` (guide injected when an objective mentions SkillApps).
- Service: `packages/service/src/SkillAppRoutes.ts` (`/v1/apps`, `/v1/app-instances/...`). Web: `apps/web/src/screens/apps/AppsScreen.tsx` (instance and execution flow), `apps/web/src/screens/apps/SkillAppLayout.tsx` (layout renderers), `apps/web/src/screens/apps/skillAppHelpers.ts`, `apps/web/src/screens/apps/useAppsCatalog.ts`, `apps/web/src/api/apps.ts` (bookmarkable `/apps/<name>`).

Tests: `packages/core/tests/SkillApp.test.ts`, `apps/web/tests/components/apps.test.tsx`.
