import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preApproved, resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { assessFileRead, assessFileRemoval, assessFileWrite } from '../src/agent/FilePolicy';
import { createRunWorkspace, type RunWorkspace } from '../src/agent/RunWorkspace';
import type { ToolExecutionContext, ToolRiskAssessment } from '../src/agent/ToolRegistry';
import { MakeDirectoryTool, MovePathTool, TrashPathTool } from '../src/agent/tools/FileManagementTools';
import { WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { WorkspaceExecutor } from '../src/workspace/WorkspaceExecutor';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function setup(): { home: string; outside: string; workspace: RunWorkspace; ctx: ToolExecutionContext } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-policy-home-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-policy-outside-')));
  dirs.push(home, outside);
  const workspace = createRunWorkspace({ id: 'run_policy', runsDir: path.join(home, '.marifold', 'runs'), userHome: home, cwd: path.join(home, '.marifold', 'runs') });
  return { home, outside, workspace, ctx: { cwd: workspace.cwd, outputLimit: 100000, workspace } };
}

/** Items in this test home's Trash (macOS .Trash or the XDG layout). */
function trashed(home: string): string[] {
  const dir = process.platform === 'darwin' ? path.join(home, '.Trash') : path.join(home, '.local', 'share', 'Trash', 'files');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('file policy', () => {
  it('reads anywhere freely, asking only for sensitive roots', () => {
    const { home, outside, workspace } = setup();
    expect(assessFileRead(path.join(home, 'Documents', 'a.txt'), workspace)).toEqual({ escalate: false });
    expect(assessFileRead(path.join(outside, 'a.txt'), workspace)).toEqual({ escalate: false });
    expect(assessFileRead(path.join(home, '.ssh', 'id_ed25519'), workspace)).toMatchObject({ escalate: true, sensitiveGrant: '~/.ssh' });
    expect(assessFileRead(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'), workspace))
      .toMatchObject({ escalate: true, sensitiveGrant: '~/Library/Application Support/Google/Chrome' });
    // Marifold's own state is approved one read at a time.
    const state = assessFileRead(path.join(home, '.marifold', 'config.toml'), workspace);
    expect(state).toMatchObject({ escalate: true, persistable: false });
    expect(state.sensitiveGrant).toBeUndefined();
  });

  it('treats ordinary home writes as routine and asks for everything riskier', () => {
    const { home, outside, workspace } = setup();
    expect(assessFileWrite(path.join(home, 'tempfiles', 'a.txt'), workspace)).toEqual({ escalate: false, routine: true });
    for (const target of [
      path.join(home, '.zshrc'),
      path.join(home, 'Library', 'LaunchAgents', 'x.plist'),
      path.join(home, '.ssh', 'authorized_keys'),
      path.join(outside, 'a.txt'),
    ]) {
      expect(assessFileWrite(target, workspace), target).toMatchObject({ escalate: true, persistable: false });
    }
    // A symlink in home that points outside it is judged by its destination.
    fs.symlinkSync(outside, path.join(home, 'link'));
    expect(assessFileWrite(path.join(home, 'link', 'a.txt'), workspace)).toMatchObject({ escalate: true, persistable: false });
  });

  it('never removes home and asks before removing a folder holding credentials', () => {
    const { home, workspace } = setup();
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    fs.mkdirSync(path.join(home, 'notes'));
    expect(assessFileRemoval(home, workspace)).toMatchObject({ blocked: true });
    expect(assessFileRemoval(path.dirname(home), workspace)).toMatchObject({ blocked: true });
    expect(assessFileRemoval(path.join(home, 'Library'), workspace)).toMatchObject({ escalate: true, persistable: false });
    expect(assessFileRemoval(path.join(home, 'notes'), workspace)).toEqual({ escalate: false, routine: true });
  });

  it('pre-approves routine work unless denied, and sensitive reads only when granted', () => {
    const routine: ToolRiskAssessment = { escalate: false, routine: true };
    const sensitive: ToolRiskAssessment = { escalate: true, sensitiveGrant: '~/.ssh' };
    const none = resolveAgentConfig({});
    const granted = resolveAgentConfig({ sensitiveReadGrants: ['~/.ssh'] });
    expect(preApproved(routine, 'ask', none)).toBe(true);
    expect(preApproved(routine, 'deny', none)).toBe(false);
    expect(preApproved({ escalate: false }, 'ask', none)).toBe(false);
    expect(preApproved(sensitive, 'allow', none)).toBe(false);
    expect(preApproved(sensitive, 'allow', granted)).toBe(true);
    expect(preApproved({ escalate: true, sensitiveGrant: '~/.aws' }, 'allow', granted)).toBe(false);
    expect(preApproved(sensitive, 'deny', granted)).toBe(false);
  });
});

describe('file management tools', () => {
  it('creates folders and renames entries without replacing anything', async () => {
    const { home, ctx } = setup();
    const make = new MakeDirectoryTool();
    const move = new MovePathTool();
    const original = path.join(home, 'tempfiles', '26102202-打车从酒店去 900 医院-32.90');
    expect(make.assessRisk({ path: original }, ctx)).toEqual({ escalate: false, routine: true });
    expect((await make.execute({ path: original }, ctx)).isError).toBeUndefined();
    expect((await make.execute({ path: original }, ctx)).content).toContain('already exists');

    const renamed = path.join(home, 'tempfiles', '26102202-打车从酒店去_900_医院-32.90');
    expect(move.assessRisk({ source: original, destination: renamed }, ctx)).toEqual({ escalate: false, routine: true });
    expect((await move.execute({ source: original, destination: renamed }, ctx)).isError).toBeUndefined();
    expect(fs.statSync(renamed).isDirectory()).toBe(true);

    fs.mkdirSync(original);
    const clash = await move.execute({ source: original, destination: renamed }, ctx);
    expect(clash.isError).toBe(true);
    expect(clash.content).toContain('already exists');
    expect(fs.existsSync(original)).toBe(true);
  });

  it('asks before moving credentials out of their store', () => {
    const { home, ctx } = setup();
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
    expect(new MovePathTool().assessRisk({ source: '~/.ssh/id_ed25519', destination: '~/tempfiles/key' }, ctx))
      .toMatchObject({ escalate: true, persistable: false });
  });

  it('moves deletions and overwritten versions to the Trash', async () => {
    const { home, ctx } = setup();
    fs.mkdirSync(path.join(home, 'docs'));
    fs.writeFileSync(path.join(home, 'docs', 'draft.txt'), 'draft');
    const trash = new TrashPathTool();
    expect(trash.assessRisk({ path: '~/docs/draft.txt' }, ctx)).toEqual({ escalate: false, routine: true });
    const result = await trash.execute({ path: '~/docs/draft.txt' }, ctx);
    expect(result.isError, result.content).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'docs', 'draft.txt'))).toBe(false);
    expect(trashed(home)).toEqual(['draft.txt']);
    expect((await trash.execute({ path: '~' }, ctx)).isError).toBe(true);

    fs.writeFileSync(path.join(home, 'docs', 'notes.md'), 'old');
    const write = await new WriteFileTool().execute({ path: '~/docs/notes.md', content: 'new' }, ctx);
    expect(write.content).toContain('previous version');
    expect(fs.readFileSync(path.join(home, 'docs', 'notes.md'), 'utf8')).toBe('new');
    expect(fs.readdirSync(path.join(home, 'docs'))).toEqual(['notes.md']);
    expect(trashed(home).filter(name => name.startsWith('notes (before '))).toHaveLength(1);
  });
});

describe('guest execution', () => {
  it('reports the device assessment instead of forcing a prompt for every call', async () => {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-policy-runs-'));
    dirs.push(runs);
    const executor = new WorkspaceExecutor(() => resolveAgentConfig({}), runs);
    const context = { workspaceId: 'workspace', senderDeviceId: 'host', hostDeviceId: 'host' };
    try {
      await executor.handle('executor.prepare', { runId: 'policy_run' }, context);
      const assess = (tool: string, input: Record<string, string>) =>
        executor.handle('executor.assess', { runId: 'policy_run', tool, input }, context) as Promise<ToolRiskAssessment>;
      expect(await assess('make_directory', { path: '~/marifold-policy-test-never-created/a' }))
        .toMatchObject({ escalate: false, routine: true, blocked: false });
      expect(await assess('read_file', { path: '~/.ssh/config' })).toMatchObject({ escalate: true, sensitiveGrant: '~/.ssh' });
      expect(await assess('write_file', { path: '~/.zshrc', content: '' })).toMatchObject({ escalate: true, persistable: false });
      // Full-access shell and sudo stay one call at a time on guests too.
      expect(await assess('shell_exec', { command: 'id', access: 'full' })).toMatchObject({ escalate: true, persistable: false });
      expect(await assess('sudo_exec', { command: 'id' })).toMatchObject({ escalate: true, persistable: false });
    } finally {
      executor.close();
    }
  });
});
