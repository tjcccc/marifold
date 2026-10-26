import * as fs from 'fs';
import Database from 'better-sqlite3';
import type { AgentComputer } from '../computer/AgentComputer';
import type { LoadedMarifoldConfig } from '../config/ConfigSchema';
import { ConfigManager } from '../config/ConfigManager';
import { sameMentionName } from '../agent/Mentions';
import { MarifoldError } from '../errors/MarifoldError';
import { renameProjectProfile } from '../projects/ProjectStore';
import { ScheduleStore } from '../schedule/ScheduleStore';
import { hasProfileDisplayTable, PROFILE_DISPLAY_TABLE } from '../sessions/SessionDisplayTables';
import { TaskStore } from '../tasks/TaskStore';
import type { ProfileManager } from './ProfileManager';

/**
 * A profile's name is also the key of everything kept outside its folder:
 * sessions, the profile pin and project rosters in the sessions database, task and schedule
 * records, `default.profile`, the Telegram channel, and the agent computer
 * account. Renaming moves all of them, so nothing is left under the old name.
 */

export interface ProfileRenameOutcome {
  from: string;
  to: string;
  /** Undefined when only records were moved (finishing an earlier rename). */
  fromPath?: string;
  toPath?: string;
  sessions: number;
  tasks: number;
  schedules: number;
  defaultProfile: boolean;
  telegram: boolean;
}

export interface ProfileRenameDeps {
  loadedConfig: LoadedMarifoldConfig;
  profileManager: ProfileManager;
  agentComputer: AgentComputer;
  /** Workspace device names and ids the new name must not reuse. */
  deviceNames?: () => readonly string[];
}

/** Refuse a profile name a workspace device already answers to: `@name`
 * would be ambiguous. Names that already collide stay as they are. */
export function assertNotDeviceName(name: string, deviceNames?: () => readonly string[]): void {
  if (deviceNames?.().some(device => sameMentionName(device, name))) {
    throw MarifoldError.profileInvalid(`A device in this workspace is named '${name}', so @${name} would be ambiguous. Choose another profile name.`, name);
  }
}

/**
 * Rename a profile and move its records. When `from` no longer exists but
 * `to` does and records still name `from`, only the records move: this
 * repairs a rename made before records followed it.
 */
export async function renameProfile(deps: ProfileRenameDeps, from: string, to: string): Promise<ProfileRenameOutcome> {
  const { loadedConfig, profileManager } = deps;
  const paths = loadedConfig.config.paths;
  const fromExists = profileManager.exists(from);
  let moved: { fromPath: string; toPath: string } | undefined;
  if (fromExists || !profileManager.exists(to)) {
    assertNotDeviceName(to, deps.deviceNames);
    const result = profileManager.rename(from, to);
    moved = { fromPath: result.fromPath, toPath: result.toPath };
  } else if (!profileRecordCount(paths.sessionsDb, from)) {
    throw MarifoldError.profileInvalid(`Profile '${from}' was not found and nothing is stored under that name.`, from);
  }
  let sessions: number;
  try {
    sessions = moveSessions(paths.sessionsDb, from, to);
  } catch (error) {
    if (moved) { fs.renameSync(moved.toPath, moved.fromPath); }
    throw error;
  }
  const tasks = new TaskStore(paths.tasksDir).reassignProfile(from, to);
  const schedules = paths.schedulesDir ? new ScheduleStore(paths.schedulesDir).reassignProfile(from, to) : 0;
  const config = loadedConfig.config;
  const defaultProfile = config.default.profile === from;
  const telegram = config.channels?.telegram?.profile === from;
  if (defaultProfile) { config.default.profile = to; }
  if (telegram) { config.channels!.telegram!.profile = to; }
  if (defaultProfile || telegram) { new ConfigManager(loadedConfig).save(); }
  await deps.agentComputer.renameAccount(from, to);
  return { from, to, ...moved, sessions, tasks, schedules, defaultProfile, telegram };
}

/** Sessions stored under a profile name. */
export function profileRecordCount(sessionsDb: string, name: string): number {
  return sessionCounts(sessionsDb).get(name) ?? 0;
}

/** Profile names that have sessions but no profile, with their session counts. */
export function orphanedSessionProfiles(sessionsDb: string, exists: (name: string) => boolean): Array<{ name: string; sessions: number }> {
  return [...sessionCounts(sessionsDb)]
    .filter(([name]) => !exists(name))
    .map(([name, sessions]) => ({ name, sessions }));
}

function sessionCounts(sessionsDb: string): Map<string, number> {
  if (!fs.existsSync(sessionsDb)) { return new Map(); }
  const db = new Database(sessionsDb, { fileMustExist: true, readonly: true });
  try {
    const hasSessions = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get();
    if (!hasSessions) { return new Map(); }
    const rows = db.prepare('SELECT profile_name AS name, COUNT(*) AS count FROM sessions WHERE profile_name IS NOT NULL GROUP BY profile_name').all() as Array<{ name: string; count: number }>;
    return new Map(rows.map(row => [row.name, row.count]));
  } finally {
    db.close();
  }
}

/** One transaction: the sessions, the profile pin, and project rosters, Leads
 * and floors move together or not at all. */
function moveSessions(sessionsDb: string, from: string, to: string): number {
  if (!fs.existsSync(sessionsDb)) { return 0; }
  const db = new Database(sessionsDb, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return db.transaction(() => {
      const hasSessions = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get();
      const changes = hasSessions ? db.prepare('UPDATE sessions SET profile_name = ? WHERE profile_name = ?').run(to, from).changes : 0;
      renameProjectProfile(db, from, to);
      if (hasProfileDisplayTable(db)) {
        db.prepare(`DELETE FROM ${PROFILE_DISPLAY_TABLE} WHERE profile_name = ? AND EXISTS (SELECT 1 FROM ${PROFILE_DISPLAY_TABLE} WHERE profile_name = ?)`).run(to, from);
        db.prepare(`UPDATE ${PROFILE_DISPLAY_TABLE} SET profile_name = ? WHERE profile_name = ?`).run(to, from);
      }
      return changes;
    })();
  } finally {
    db.close();
  }
}
