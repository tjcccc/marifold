import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/schedule/Scheduler';
import { ScheduleStore } from '../src/schedule/ScheduleStore';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-schedule-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ScheduleStore', () => {
  it('creates, lists, updates, and deletes schedules with file persistence', () => {
    const store = new ScheduleStore(tempDir());
    const created = store.create({ name: 'Daily digest', objective: 'Summarize the news.', cron: '0 9 * * *' });
    expect(created.enabled).toBe(true);
    expect(created.id).toMatch(/^sched_/);

    expect(store.list()).toHaveLength(1);
    expect(store.get(created.id)?.name).toBe('Daily digest');

    const updated = store.update(created.id, { enabled: false, lastTaskId: 'task_x', lastResultSeen: false });
    expect(updated.enabled).toBe(false);
    expect(updated.lastTaskId).toBe('task_x');
    expect(updated.lastResultSeen).toBe(false);

    expect(store.delete(created.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.delete(created.id)).toBe(false);
  });

  it('rejects invalid cron expressions and empty fields', () => {
    const store = new ScheduleStore(tempDir());
    expect(() => store.create({ name: 'x', objective: 'y', cron: 'not a cron' })).toThrow(/Invalid cron/);
    expect(() => store.create({ name: '', objective: 'y', cron: '* * * * *' })).toThrow(/name cannot be empty/);
  });

  it('computes due schedules from lastRunAt with a fake clock', () => {
    const store = new ScheduleStore(tempDir());
    const schedule = store.create({ name: 'hourly', objective: 'tick', cron: '0 * * * *' });

    // Just created: the next firing after createdAt is the next full hour.
    const createdAt = new Date(schedule.createdAt);
    const nextHour = new Date(createdAt);
    nextHour.setHours(createdAt.getHours() + 1, 0, 0, 0);

    expect(store.due(new Date(nextHour.getTime() - 60_000))).toHaveLength(0);
    expect(store.due(new Date(nextHour.getTime() + 1_000))).toHaveLength(1);

    // After recording a run at the firing time, it is no longer due until the next hour.
    store.update(schedule.id, { lastRunAt: new Date(nextHour.getTime() + 1_000).toISOString() });
    expect(store.due(new Date(nextHour.getTime() + 120_000))).toHaveLength(0);
    expect(store.due(new Date(nextHour.getTime() + 61 * 60_000))).toHaveLength(1);
  });

  it('skips disabled schedules', () => {
    const store = new ScheduleStore(tempDir());
    const schedule = store.create({ name: 'm', objective: 'tick', cron: '* * * * *', enabled: false });
    expect(store.due(new Date(Date.now() + 120_000))).toHaveLength(0);
    store.update(schedule.id, { enabled: true });
    expect(store.due(new Date(Date.now() + 120_000))).toHaveLength(1);
  });
});

describe('Scheduler', () => {
  it('fires due schedules, records the firing first, and stores the task result', async () => {
    const store = new ScheduleStore(tempDir());
    const schedule = store.create({ name: 'minutely', objective: 'tick', cron: '* * * * *' });
    const ran: string[] = [];

    const scheduler = new Scheduler({
      store,
      runSchedule: async item => {
        ran.push(item.id);
        // lastRunAt must already be recorded before the run starts.
        expect(store.get(item.id)?.lastRunAt).toBeDefined();
        return { taskId: 'task_123', status: 'completed' };
      },
    });

    const fired = await scheduler.tick(new Date(Date.now() + 120_000));
    expect(fired).toBe(1);
    expect(ran).toEqual([schedule.id]);

    const after = store.get(schedule.id)!;
    expect(after.lastTaskId).toBe('task_123');
    expect(after.lastResultSeen).toBe(false);

    // Same tick time again: already fired, not due.
    expect(await scheduler.tick(new Date(Date.now() + 120_000))).toBe(0);
  });

  it('keeps ticking when one schedule run fails', async () => {
    const store = new ScheduleStore(tempDir());
    store.create({ name: 'boom', objective: 'fail', cron: '* * * * *' });
    const logs: string[] = [];

    const scheduler = new Scheduler({
      store,
      runSchedule: async () => {
        throw new Error('provider exploded');
      },
      log: message => logs.push(message),
    });

    const fired = await scheduler.tick(new Date(Date.now() + 120_000));
    expect(fired).toBe(1);
    expect(logs.join('\n')).toContain('provider exploded');
  });
});
