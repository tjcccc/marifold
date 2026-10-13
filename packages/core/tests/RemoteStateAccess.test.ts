import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunWorkspace, type RunWorkspace } from '../src/agent/RunWorkspace';
import { runScopedProcess } from '../src/agent/ScopedProcess';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';
import { WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { mentionsMarifoldState, remoteStateAccess } from '../src/workspace/RemoteStateAccess';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function fixture(remote: boolean) {
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-state-')));
  dirs.push(userHome);
  const home = path.join(userHome, '.marifold');
  const skill = path.join(home, 'profiles', 'painter', 'skills', 'make-qwen-image-prompt');
  fs.mkdirSync(skill, { recursive: true });
  fs.mkdirSync(path.join(home, 'workspaces'), { recursive: true });
  for (const file of [path.join(skill, '.vars-path.toml'), path.join(home, 'config.toml'), path.join(home, 'sessions.db-wal'), path.join(home, 'agent-trace.jsonl')]) {
    fs.writeFileSync(file, 'x');
  }
  const access = remoteStateAccess(home, path.join(home, 'config.toml'), {
    profilesDir: path.join(home, 'profiles'),
    sessionsDb: path.join(home, 'sessions.db'),
    tasksDir: path.join(home, 'tasks'),
  });
  const workspace = createRunWorkspace({ id: 'run_state', runsDir: path.join(home, 'runs'), userHome, cwd: userHome, ...(remote ? access : {}) });
  return { home, skill, workspace };
}

const context = (workspace: RunWorkspace) => ({ cwd: workspace.cwd, outputLimit: 1000, workspace });

describe('Marifold state for workspace runs', () => {
  it('lets another device read profile state with approval each time, but never write it or reach secrets', () => {
    const { home, skill, workspace } = fixture(true);
    const read = new ReadFileTool();
    expect(read.assessRisk({ path: path.join(skill, '.vars-path.toml') }, context(workspace))).toMatchObject({ escalate: true, persistable: false });
    expect(read.assessRisk({ path: path.join(skill, '.vars-path.toml') }, context(workspace)).runGrantFolder).toBeUndefined();
    // Default deny: secrets, workspace keys, the sessions database, and anything unlisted.
    for (const denied of ['config.toml', 'workspaces/key', 'sessions.db-wal', 'agent-trace.jsonl']) {
      expect(read.assessRisk({ path: path.join(home, denied) }, context(workspace)), denied).toMatchObject({ blocked: true });
    }
    expect(new WriteFileTool().assessRisk({ path: path.join(skill, '.vars-path.toml'), content: 'y' }, context(workspace))).toMatchObject({ blocked: true });
  });

  it.runIf(process.platform === 'darwin')('enforces the same limits in the macOS shell sandbox', async () => {
    const { home, skill, workspace } = fixture(true);
    const vars = path.join(skill, '.vars-path.toml');
    // Even roots opened explicitly for read and write cannot reach past the state rules.
    const result = await runScopedProcess({
      executable: '/bin/sh',
      args: ['-c', `echo ok; cat "${vars}"; echo; cat "${path.join(home, 'config.toml')}" || echo config-denied; (echo y > "${vars}") || echo write-denied`],
      workspace,
      readRoots: [workspace.workDir, home],
      writeRoots: [workspace.workDir, home],
      outputLimit: 10000,
      successSummary: 'ok',
      failureSummary: 'failed',
    });
    expect(result.content).toMatch(/^ok\nx\n/);
    expect(result.content).toContain('config-denied');
    expect(result.content).toContain('write-denied');
    expect(fs.readFileSync(vars, 'utf8')).toBe('x');
  });

  it('keeps no hard block on Marifold state for the device itself', () => {
    const { home, workspace } = fixture(false);
    const risk = new ReadFileTool().assessRisk({ path: path.join(home, 'workspaces', 'key') }, context(workspace));
    expect(risk).toMatchObject({ escalate: true, persistable: false });
    expect(risk.blocked).toBeFalsy();
  });

  it('recognizes requests about ~/.marifold', () => {
    expect(mentionsMarifoldState('Tell me the content in `~/.marifold/profiles/painter/x.toml`')).toBe(true);
    expect(mentionsMarifoldState('list ~/.marifold')).toBe(true);
    expect(mentionsMarifoldState('read /Users/me/.marifold/config.toml')).toBe(true);
    expect(mentionsMarifoldState('read ~/.marifold-notes/a.md')).toBe(false);
  });
});
