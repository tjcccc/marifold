import { ScheduleState, ScheduleStore } from './ScheduleStore';

const DEFAULT_TICK_MS = 30_000;

export interface ScheduleRunResult {
  taskId?: string;
  status: string;
}

export interface SchedulerDeps {
  store: ScheduleStore;
  /** Executes one scheduled run (unattended agent run) and reports the task outcome. */
  runSchedule: (schedule: ScheduleState) => Promise<ScheduleRunResult>;
  tickMs?: number;
  log?: (message: string) => void;
}

/**
 * Minute-resolution scheduler intended to live inside the long-running
 * `marifold service` process. Schedules only fire while the service runs;
 * a firing missed during downtime fires once on the next tick.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** Invalid schedule files already reported, so a tick every 30s does not repeat them. */
  private reported = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) { return; }
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        this.deps.log?.(`Scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run all due schedules sequentially. Returns the number fired. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.ticking) { return 0; }
    this.ticking = true;
    try {
      const invalid = new Set<string>();
      const due = this.deps.store.due(now, (file, error) => {
        const message = `Skipping invalid schedule ${file}: ${error instanceof Error ? error.message : String(error)}`;
        invalid.add(message);
        if (!this.reported.has(message)) { this.deps.log?.(message); }
      });
      this.reported = invalid;
      for (const schedule of due) {
        try {
          // Record the firing before running so a crash mid-run does not
          // retrigger the same firing on restart. A schedule removed since the
          // listing fails here without affecting the others.
          this.deps.store.update(schedule.id, { lastRunAt: now.toISOString() });
          const result = await this.deps.runSchedule(schedule);
          this.deps.store.update(schedule.id, {
            ...(result.taskId ? { lastTaskId: result.taskId } : {}),
            lastResultSeen: false,
          });
          this.deps.log?.(`Schedule ${schedule.id} (${schedule.name}) finished: ${result.status}${result.taskId ? ` task ${result.taskId}` : ''}`);
        } catch (error) {
          this.deps.log?.(`Schedule ${schedule.id} (${schedule.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return due.length;
    } finally {
      this.ticking = false;
    }
  }
}
