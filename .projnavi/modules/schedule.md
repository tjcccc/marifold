# Schedule Module

Cron-scheduled unattended agent runs, hosted inside `marifold service`.

Use this note for: schedules, cron evaluation, the scheduler tick loop, or unattended approval.

- `schedule/ScheduleStore.ts` — JSON-file schedule records under `[paths].schedules_dir`; cron via `croner`; `due(now)` and `nextRun(schedule)` compute firings; `lastResultSeen` flag for a future inbox.
- `schedule/Scheduler.ts` — minute-resolution `tick()` loop; records `lastRunAt` before running (crash-safe), runs `AgentRunner` unattended, stores `lastTaskId`.
- Hosted by `packages/service/src/MarifoldService.ts` (scheduler starts with the server). CLI: `packages/cli/src/commands/schedule.ts`. Read-only `/v1/schedules` routes.
- Schedules fire only while the service runs; daemonization is deferred.
