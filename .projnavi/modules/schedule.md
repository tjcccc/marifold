# Schedule Module

Cron-scheduled unattended agent runs, hosted inside `marifold service`. Lives in `packages/core/src/schedule/`.

Use this note for: schedules, cron evaluation, the scheduler tick loop, or unattended approval.

- `packages/core/src/schedule/ScheduleStore.ts` — JSON-file schedule records (`marifold.schedule.v1`) under `[paths].schedules_dir`; cron via `croner`; `nextRun(schedule)` and `due(now)` compute firings and skip invalid files; `lastResultSeen` flags unseen results.
- `packages/core/src/schedule/Scheduler.ts` — `tick()` every 30 seconds (cron is minute-resolution); records `lastRunAt` before running so a crash cannot refire, then stores `lastTaskId`.
- `MarifoldRuntime.createScheduler()` / `runScheduleUnattended()` / private `runScheduledAgent` run `AgentRunner` with `unattended: true` and the `scheduled` tag (`packages/core/src/runtime/MarifoldRuntime.ts`).
- Service: `packages/service/src/MarifoldService.ts` starts the scheduler unless `scheduler: false` and serves `GET /v1/schedules[/:id]`; `packages/service/src/WorkspaceScheduleRoutes.ts` adds create/update/delete/run. CLI: `packages/cli/src/commands/schedule.ts`.
- Schedules fire only while the service runs.

Tests: `packages/core/tests/Schedule.test.ts`.
