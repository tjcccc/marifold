import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Cron } from 'croner';
import { MarifoldError } from '../errors/MarifoldError';

export const SCHEDULE_SCHEMA = 'marifold.schedule.v1';

export interface ScheduleState {
  schema: typeof SCHEDULE_SCHEMA;
  id: string;
  name: string;
  /** Agent objective executed on each firing. */
  objective: string;
  /** Five-field cron expression (minute precision). */
  cron: string;
  enabled: boolean;
  profile?: string;
  lastRunAt?: string;
  lastTaskId?: string;
  /** False when the latest scheduled run finished and has not been viewed.
   * Lets future clients (TUI inbox) surface unread results. */
  lastResultSeen?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateInput {
  name: string;
  objective: string;
  cron: string;
  profile?: string;
  enabled?: boolean;
}

export interface ScheduleUpdateInput {
  name?: string;
  objective?: string;
  cron?: string;
  profile?: string;
  enabled?: boolean;
  lastRunAt?: string;
  lastTaskId?: string;
  lastResultSeen?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class ScheduleStore {
  constructor(private readonly schedulesDir: string) {}

  create(input: ScheduleCreateInput): ScheduleState {
    const now = new Date().toISOString();
    validateCron(input.cron);
    const schedule: ScheduleState = {
      schema: SCHEDULE_SCHEMA,
      id: this.createScheduleId(),
      name: requiredText(input.name, 'name'),
      objective: requiredText(input.objective, 'objective'),
      cron: input.cron.trim(),
      enabled: input.enabled ?? true,
      ...(input.profile?.trim() ? { profile: input.profile.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.write(schedule);
    return schedule;
  }

  list(): ScheduleState[] {
    if (!fs.existsSync(this.schedulesDir)) return [];
    return fs.readdirSync(this.schedulesDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => this.readFile(path.join(this.schedulesDir, entry.name)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(scheduleId: string): ScheduleState | undefined {
    this.assertSafeId(scheduleId);
    const filePath = this.schedulePath(scheduleId);
    if (!fs.existsSync(filePath)) return undefined;
    return this.readFile(filePath);
  }

  require(scheduleId: string): ScheduleState {
    const schedule = this.get(scheduleId);
    if (!schedule) throw MarifoldError.scheduleNotFound(scheduleId);
    return schedule;
  }

  update(scheduleId: string, input: ScheduleUpdateInput): ScheduleState {
    const schedule = this.require(scheduleId);
    if (input.name !== undefined) schedule.name = requiredText(input.name, 'name');
    if (input.objective !== undefined) schedule.objective = requiredText(input.objective, 'objective');
    if (input.cron !== undefined) {
      validateCron(input.cron);
      schedule.cron = input.cron.trim();
    }
    if (input.profile !== undefined) {
      if (input.profile.trim()) schedule.profile = input.profile.trim();
      else delete schedule.profile;
    }
    if (input.enabled !== undefined) schedule.enabled = input.enabled;
    if (input.lastRunAt !== undefined) schedule.lastRunAt = input.lastRunAt;
    if (input.lastTaskId !== undefined) schedule.lastTaskId = input.lastTaskId;
    if (input.lastResultSeen !== undefined) schedule.lastResultSeen = input.lastResultSeen;
    schedule.updatedAt = new Date().toISOString();
    this.write(schedule);
    return schedule;
  }

  delete(scheduleId: string): boolean {
    this.assertSafeId(scheduleId);
    const filePath = this.schedulePath(scheduleId);
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath);
    return true;
  }

  /**
   * Next firing strictly after the given reference time (last run when
   * recorded, otherwise creation time). Undefined when the pattern never
   * fires again.
   */
  nextRun(schedule: ScheduleState, now: Date = new Date()): Date | undefined {
    const reference = schedule.lastRunAt ?? schedule.createdAt;
    const cron = new Cron(schedule.cron);
    const next = cron.nextRun(new Date(reference));
    if (!next) return undefined;
    // A firing that was missed (e.g. while the service was down) is due now.
    return next <= now ? next : next;
  }

  /** Enabled schedules whose next firing time has passed. */
  due(now: Date = new Date()): ScheduleState[] {
    return this.list().filter(schedule => {
      if (!schedule.enabled) return false;
      const next = this.nextRun(schedule, now);
      return next !== undefined && next <= now;
    });
  }

  private createScheduleId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = `sched_${crypto.randomBytes(4).toString('hex')}`;
      if (!fs.existsSync(this.schedulePath(id))) return id;
    }
    throw MarifoldError.scheduleInvalid('Could not create a unique schedule id.');
  }

  private schedulePath(scheduleId: string): string {
    this.assertSafeId(scheduleId);
    return path.join(this.schedulesDir, `${scheduleId}.json`);
  }

  private assertSafeId(scheduleId: string): void {
    if (!SAFE_ID.test(scheduleId)) {
      throw MarifoldError.scheduleInvalid(`Invalid schedule id '${scheduleId}'.`);
    }
  }

  private readFile(filePath: string): ScheduleState {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ScheduleState>;
      if (parsed.schema !== SCHEDULE_SCHEMA) {
        throw MarifoldError.scheduleInvalid(`Schedule file ${filePath} has an unsupported schema.`);
      }
      return {
        schema: SCHEDULE_SCHEMA,
        id: requiredText(parsed.id, 'id'),
        name: requiredText(parsed.name, 'name'),
        objective: requiredText(parsed.objective, 'objective'),
        cron: requiredText(parsed.cron, 'cron'),
        enabled: parsed.enabled !== false,
        ...(parsed.profile ? { profile: parsed.profile } : {}),
        ...(parsed.lastRunAt ? { lastRunAt: parsed.lastRunAt } : {}),
        ...(parsed.lastTaskId ? { lastTaskId: parsed.lastTaskId } : {}),
        ...(parsed.lastResultSeen !== undefined ? { lastResultSeen: parsed.lastResultSeen } : {}),
        createdAt: requiredText(parsed.createdAt, 'createdAt'),
        updatedAt: requiredText(parsed.updatedAt, 'updatedAt'),
      };
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw MarifoldError.scheduleInvalid(`Could not read schedule ${filePath}: ${String(error)}`);
    }
  }

  private write(schedule: ScheduleState): void {
    fs.mkdirSync(this.schedulesDir, { recursive: true });
    const filePath = this.schedulePath(schedule.id);
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(schedule, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  }
}

function validateCron(expression: string): void {
  try {
    new Cron(expression.trim());
  } catch (error) {
    throw MarifoldError.scheduleInvalid(`Invalid cron expression '${expression}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw MarifoldError.scheduleInvalid(`Schedule ${label} cannot be empty.`);
}
