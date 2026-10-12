import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentConfig } from '../src/agent/ApprovalPolicy';
import { SkillManagementTool } from '../src/agent/tools/SkillManagementTool';
import { MAX_SKILL_BUNDLE_FILES, readSkillBundle, stageSkillBundle } from '../src/skill/SkillBundle';
import { SkillStore } from '../src/skill/SkillStore';
import { WorkspaceExecutor } from '../src/workspace/WorkspaceExecutor';

const dirs: string[] = [];
const executors: WorkspaceExecutor[] = [];
afterEach(() => {
  for (const executor of executors.splice(0)) { executor.close(); }
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skill-bundle-'));
  dirs.push(dir);
  return dir;
}
function skillFolder(root: string, name = 'qwen-prompt'): string {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n\nWrite a prompt.\n`);
  fs.writeFileSync(path.join(folder, 'references', 'usage.md'), 'Usage.');
  return folder;
}
const context = { workspaceId: 'workspace', senderDeviceId: 'host', hostDeviceId: 'host' };

describe('skill bundles', () => {
  it('round-trips a folder and refuses symlinks and oversized sources', () => {
    const root = tempDir();
    const folder = skillFolder(root);
    const staged = stageSkillBundle(readSkillBundle(folder));
    dirs.push(staged);
    expect(fs.readFileSync(path.join(staged, 'references', 'usage.md'), 'utf-8')).toBe('Usage.');

    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(folder, 'link.txt'));
    expect(() => readSkillBundle(folder)).toThrow('symlinks');
    fs.rmSync(path.join(folder, 'link.txt'));
    for (let i = 0; i < MAX_SKILL_BUNDLE_FILES; i++) { fs.writeFileSync(path.join(folder, `f${i}.md`), ''); }
    expect(() => readSkillBundle(folder)).toThrow('more than');
  });

  it('rejects unsafe paths in a received bundle', () => {
    for (const bad of ['../x', '/etc/x', 'a//b', 'a\\b', '']) {
      expect(() => stageSkillBundle({ files: [{ path: bad, data: '' }] }), bad).toThrow();
    }
  });
});

describe('executor.skillBundle', () => {
  it('reads a source on this device but never protected state or a folder containing it', async () => {
    const root = tempDir();
    const marifold = path.join(root, '.marifold');
    fs.mkdirSync(marifold);
    skillFolder(marifold, 'inside');
    const executor = new WorkspaceExecutor(() => resolveAgentConfig(), path.join(root, 'runs'), [marifold]);
    executors.push(executor);

    const bundle = await executor.handle('executor.skillBundle', { path: skillFolder(root) }, context) as { files: Array<{ path: string }> };
    expect(bundle.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'references/usage.md']);
    await expect(executor.handle('executor.skillBundle', { path: path.join(marifold, 'inside') }, context)).rejects.toThrow('protected');
    await expect(executor.handle('executor.skillBundle', { path: root }, context)).rejects.toThrow('protected');
    await expect(executor.handle('executor.skillBundle', { path: '~' }, context)).rejects.toThrow('protected');

    const denied = new WorkspaceExecutor(() => resolveAgentConfig({ approval: { read: 'deny' } }), path.join(root, 'runs'));
    executors.push(denied);
    await expect(denied.handle('executor.skillBundle', { path: skillFolder(root, 'other') }, context)).rejects.toThrow('denies');
  });
});

describe('manage_skill source_device', () => {
  function tool(root: string) {
    const globalDir = path.join(root, 'skills');
    const profileDir = path.join(root, 'profiles', 'writer', 'skills');
    return {
      globalDir,
      tool: new SkillManagementTool({ store: new SkillStore({ globalDir, profileDir }), profile: 'writer', globalDir, profileDir }),
    };
  }

  it('installs a bundle read on the named device and reports where it came from', async () => {
    const root = tempDir();
    const remote = skillFolder(path.join(root, 'office'));
    const { globalDir, tool: skills } = tool(root);
    const fetched: string[] = [];
    skills.useSourceDevices({
      hostName: 'Home',
      resolve: device => (device === 'office' ? { id: 'office-id', name: 'Office', host: false } : { id: 'home-id', name: 'Home', host: true }),
      fetch: async (deviceId, source) => {
        fetched.push(`${deviceId}:${source}`);
        return readSkillBundle(remote);
      },
    });

    const result = await skills.execute({ action: 'install', scope: 'global', source: '~/skills/qwen-prompt', source_device: 'office' }, { cwd: root, outputLimit: 100000 });
    expect(result.isError, result.content).toBeFalsy();
    expect(result.content).toContain('from Office:~/skills/qwen-prompt');
    expect(fetched).toEqual(['office-id:~/skills/qwen-prompt']);
    expect(fs.readFileSync(path.join(globalDir, 'qwen-prompt', 'references', 'usage.md'), 'utf-8')).toBe('Usage.');

    const local = await skills.execute({ action: 'install', scope: 'global', source: skillFolder(root, 'local-skill') }, { cwd: root, outputLimit: 100000 });
    expect(local.content).toContain(`from Home:${path.join(root, 'local-skill')}`);
  });

  it('refuses source_device outside a workspace run', async () => {
    const root = tempDir();
    const result = await tool(root).tool.execute(
      { action: 'install', scope: 'global', source: skillFolder(root), source_device: 'office' },
      { cwd: root, outputLimit: 100000 },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('only in a workspace run');
  });
});
