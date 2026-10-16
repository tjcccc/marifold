import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MarifoldRuntime, orphanedSessionProfiles } from '../src';
import type { MarifoldConfig } from '../src/config/ConfigSchema';
import { ScheduleStore } from '../src/schedule/ScheduleStore';
import { TaskStore } from '../src/tasks/TaskStore';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function setup(): { runtime: MarifoldRuntime; config: MarifoldConfig; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-rename-'));
  tempDirs.push(dir);
  const config: MarifoldConfig = {
    default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'abc', deep: false },
    models: { options: ['ollama/gemma4:e4b'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: {
      profilesDir: path.join(dir, 'profiles'),
      skillsDir: path.join(dir, 'skills'),
      sessionsDb: path.join(dir, 'sessions.db'),
      tasksDir: path.join(dir, 'tasks'),
      schedulesDir: path.join(dir, 'schedules'),
    },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
  };
  const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(dir, 'config.toml'), foundConfig: true } });
  runtime.initProfile('abc');
  const db = new Database(config.paths.sessionsDb);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, profile_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL)`);
  db.prepare("INSERT INTO sessions VALUES ('s1','abc','2026-01-01','2026-01-01','{}'), ('s2','other','2026-01-01','2026-01-01','{}')").run();
  db.close();
  runtime.setProfilePinned('abc', true);
  new TaskStore(config.paths.tasksDir).create({ objective: 'x', profile: 'abc' });
  new ScheduleStore(config.paths.schedulesDir!).create({ name: 'n', objective: 'x', cron: '0 9 * * *', profile: 'abc' });
  return { runtime, config, dir };
}

function sessionProfiles(dbPath: string): Record<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id, profile_name AS profile FROM sessions').all() as Array<{ id: string; profile: string }>;
    return Object.fromEntries(rows.map(row => [row.id, row.profile]));
  } finally { db.close(); }
}

describe('profile rename', () => {
  it('moves sessions, the pin, tasks, schedules and the default with the profile', async () => {
    const { runtime, config } = setup();
    const result = await runtime.renameProfile('abc', 'helper');
    expect(result).toMatchObject({ sessions: 1, tasks: 1, schedules: 1, defaultProfile: true });
    expect(sessionProfiles(config.paths.sessionsDb)).toEqual({ s1: 'helper', s2: 'other' });
    expect(runtime.listProfiles().find(profile => profile.name === 'helper')).toMatchObject({ pinned: true });
    expect(new TaskStore(config.paths.tasksDir).list()[0]!.profile).toBe('helper');
    expect(new ScheduleStore(config.paths.schedulesDir!).list()[0]!.profile).toBe('helper');
    expect(config.default.profile).toBe('helper');
  });

  it('moves sessions an earlier rename left behind when run again', async () => {
    const { runtime, config } = setup();
    fs.renameSync(path.join(config.paths.profilesDir, 'abc'), path.join(config.paths.profilesDir, 'helper'));
    expect(orphanedSessionProfiles(config.paths.sessionsDb, name => name !== 'abc'))
      .toEqual([{ name: 'abc', sessions: 1 }]);
    const result = await runtime.renameProfile('abc', 'helper');
    expect(result.fromPath).toBeUndefined();
    expect(sessionProfiles(config.paths.sessionsDb).s1).toBe('helper');
    await expect(runtime.renameProfile('abc', 'helper')).rejects.toThrow(/nothing is stored/);
  });
});
