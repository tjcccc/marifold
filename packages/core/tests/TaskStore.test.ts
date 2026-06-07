import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarifoldError, TaskStore } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-task-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('TaskStore', () => {
  it('creates, lists, updates, and deletes task state snapshots', () => {
    const store = new TaskStore(tempDir());
    const created = store.create({
      objective: 'Build the v0.10 service foundation.',
      profile: 'default',
      sessionId: 'dev-session',
      plan: [
        { id: 'inspect', text: 'Inspect the current runtime', status: 'completed' },
        { id: 'service', text: 'Add the local service', status: 'in_progress' },
      ],
      nextAction: 'Add service tests.',
      tags: ['v0.10', 'agent'],
    });

    expect(created.id).toMatch(/^task_/);
    expect(created.status).toBe('running');
    expect(created.title).toBe('Build the v0.10 service foundation.');
    expect(store.list()).toHaveLength(1);

    const withEvent = store.appendEvent(created.id, {
      kind: 'decision',
      message: 'Use Fastify behind a loopback-only service command.',
    });
    expect(withEvent.events).toMatchObject([
      {
        kind: 'decision',
        message: 'Use Fastify behind a loopback-only service command.',
      },
    ]);

    const completed = store.update(created.id, {
      status: 'completed',
      summary: 'Service foundation implemented.',
      nextAction: '',
      plan: [
        { id: 'inspect', text: 'Inspect the current runtime', status: 'completed' },
        { id: 'service', text: 'Add the local service', status: 'completed' },
      ],
    });
    expect(completed.completedAt).toBeDefined();
    expect(completed.nextAction).toBeUndefined();
    expect(store.list({ status: 'completed' })[0]?.planCounts.completed).toBe(2);

    expect(store.delete(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it('rejects plans with more than one in-progress step', () => {
    const store = new TaskStore(tempDir());

    expect(() => store.create({
      objective: 'Invalid plan',
      plan: [
        { text: 'First active step', status: 'in_progress' },
        { text: 'Second active step', status: 'in_progress' },
      ],
    })).toThrow(MarifoldError);
  });

  it('rejects events that reference unknown plan steps', () => {
    const store = new TaskStore(tempDir());
    const task = store.create({
      objective: 'Keep task event references coherent.',
      plan: [
        { id: 'known', text: 'Known step' },
      ],
    });

    expect(() => store.appendEvent(task.id, {
      message: 'This points to a missing step.',
      stepId: 'missing',
    })).toThrow(MarifoldError);
  });
});
