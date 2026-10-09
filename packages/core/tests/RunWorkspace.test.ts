import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunWorkspace,
  isProtectedSystemWrite,
  resolveToolPath,
} from '../src/agent/RunWorkspace';
import { macSandboxProfile } from '../src/agent/ScopedProcess';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';
import { WriteFileTool } from '../src/agent/tools/WriteFileTool';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-run-workspace-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('RunWorkspace', () => {
  it('retains generated downloads while pruning expired scratch state and empty runs', () => {
    const home = tempDir();
    const runsDir = path.join(home, '.marifold', 'runs');
    const options = { cwd: home, userHome: home, runsDir };
    const generated = createRunWorkspace({ ...options, id: 'run_generated' });
    const empty = createRunWorkspace({ ...options, id: 'run_empty' });
    fs.writeFileSync(path.join(generated.outputDir, 'result.txt'), 'durable bytes');
    fs.writeFileSync(path.join(generated.workDir, 'scratch.txt'), 'temporary');
    const old = new Date(Date.now() - 2 * 86400000);
    fs.utimesSync(generated.rootDir, old, old);
    fs.utimesSync(empty.rootDir, old, old);
    createRunWorkspace({ ...options, id: 'run_next' });
    expect(fs.readFileSync(path.join(generated.outputDir, 'result.txt'), 'utf8')).toBe('durable bytes');
    expect(fs.existsSync(generated.workDir)).toBe(false);
    expect(fs.existsSync(empty.rootDir)).toBe(false);
  });

  it('creates private run directories and stages binary inputs read-only', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'run_test',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      files: [{
        name: '../budget.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: Buffer.from('xlsx-bytes').toString('base64'),
      }],
    });

    expect(workspace.cwd).toBe(fs.realpathSync(cwd));
    expect(workspace.files).toHaveLength(1);
    expect(workspace.attachments).toHaveLength(1);
    expect(workspace.attachments[0].id).toBe('attachment-1');
    expect(workspace.files[0].name).toBe('budget.xlsx');
    expect(fs.readFileSync(workspace.files[0].path, 'utf8')).toBe('xlsx-bytes');
    expect(fs.statSync(workspace.files[0].path).mode & 0o222).toBe(0);
    expect(resolveToolPath('~', workspace, cwd)).toBe(fs.realpathSync(home));
    expect(resolveToolPath('~/note.txt', workspace, cwd)).toBe(path.join(fs.realpathSync(home), 'note.txt'));
    expect(resolveToolPath('~/note.txt', workspace, cwd)).not.toBe(path.join(workspace.homeDir, 'note.txt'));
  });

  it('copies images into the read-only attachment manifest', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'run_image',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      images: [{ data: Buffer.from('image-bytes').toString('base64'), mediaType: 'image/png' }],
    });

    expect(workspace.attachments).toHaveLength(1);
    expect(workspace.attachments[0]).toMatchObject({
      id: 'attachment-1',
      name: 'image-1.png',
      mediaType: 'image/png',
      size: 11,
    });
    expect(fs.readFileSync(workspace.attachments[0].path!)).toEqual(Buffer.from('image-bytes'));
    expect(fs.statSync(workspace.attachments[0].path!).mode & 0o222).toBe(0);
  });

  it('assesses and reports file tool paths at their symlink destinations', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    const outside = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(cwd);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(home, 'notes.txt'), 'private');
    const workspace = createRunWorkspace({ id: 'run_symlink', cwd, runsDir: path.join(home, '.marifold', 'runs'), userHome: home });
    const context = { cwd: workspace.cwd, workspace, trustedFolders: [] };
    const write = new WriteFileTool();
    fs.symlinkSync(path.join(outside, 'agent.plist'), path.join(cwd, 'escape'));
    fs.symlinkSync(path.join(home, '.ssh'), path.join(cwd, 'keys'));
    fs.symlinkSync(path.join(home, 'notes.txt'), path.join(cwd, 'notes'));
    fs.symlinkSync('loop', path.join(cwd, 'loop'));
    fs.symlinkSync('missing-inside.txt', path.join(cwd, 'inside'));

    // The destination, not the link inside cwd, is what an approval or a
    // "trust folder" decision must apply to.
    expect(write.assessRisk({ path: 'escape', content: '' }, context)).toMatchObject({
      escalate: true,
      persistable: true,
      targetPath: path.join(fs.realpathSync(outside), 'agent.plist'),
    });
    expect(write.assessRisk({ path: 'keys/authorized_keys', content: '' }, context)).toMatchObject({ escalate: true, persistable: false });
    expect(new ReadFileTool().assessRisk({ path: 'notes' }, context)).toMatchObject({
      escalate: true,
      targetPath: fs.realpathSync(path.join(home, 'notes.txt')),
    });
    expect(write.assessRisk({ path: 'inside', content: '' }, context)).toEqual({ escalate: false });
    // A link loop stays unresolved here because opening it fails with ELOOP.
    expect(write.assessRisk({ path: 'loop', content: '' }, context)).toEqual({ escalate: false });
    expect(() => fs.writeFileSync(path.join(cwd, 'loop'), 'x')).toThrow(/ELOOP/);
  });

  it('does not grant a broad home cwd and marks external roots', () => {
    const home = tempDir();
    const external = tempDir();
    const broad = createRunWorkspace({
      id: 'run_broad',
      cwd: home,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    expect(broad.cwd).toBe(broad.workDir);

    const privateState = path.join(home, '.marifold', 'profiles');
    fs.mkdirSync(privateState, { recursive: true });
    const sensitive = createRunWorkspace({
      id: 'run_sensitive',
      cwd: privateState,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    expect(sensitive.cwd).toBe(sensitive.workDir);

    const scoped = createRunWorkspace({
      id: 'run_external',
      cwd: external,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    expect(scoped.externalRoots).toContain(fs.realpathSync(external));
  });

  it('treats global runtime directories as protected writes and renders them read-only in the mac profile', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    const profileSkills = path.join(home, '.marifold', 'profiles', 'painter', 'skills');
    fs.mkdirSync(cwd);
    fs.mkdirSync(profileSkills, { recursive: true });
    const workspace = createRunWorkspace({
      id: 'run_policy',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      readOnlyFolders: [profileSkills],
    });
    expect(isProtectedSystemWrite('/Library/Frameworks/Python.framework/site-packages/x.py', workspace)).toBe(true);
    expect(isProtectedSystemWrite(path.join(cwd, 'x.py'), workspace)).toBe(false);
    expect(workspace.readOnlyRoots).toContain(fs.realpathSync(profileSkills));
    expect(workspace.readRoots).toContain(fs.realpathSync(profileSkills));
    expect(workspace.writeRoots).not.toContain(fs.realpathSync(profileSkills));

    const profile = macSandboxProfile(workspace, '/bin/sh', false);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny appleevent-send)');
    expect(profile).toContain('(global-name "com.apple.SecurityServer")');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(JSON.stringify(workspace.cwd));
    expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(fs.realpathSync(profileSkills))})`);
    expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(profileSkills))})`);
    expect(profile).not.toContain('(allow file-write* (subpath "/Library")');

    const installerProfile = macSandboxProfile(workspace, '/bin/sh', true, {
      readRoots: [workspace.workDir, workspace.venvDir],
      writeRoots: [workspace.workDir, workspace.venvDir],
    });
    expect(installerProfile).not.toContain(`(allow file-read* (subpath ${JSON.stringify(workspace.inputDir)})`);
    expect(installerProfile).not.toContain(`(allow file-read* (subpath ${JSON.stringify(workspace.cwd)})`);
    expect(installerProfile).toContain(`(allow file-read* (literal ${JSON.stringify(fs.realpathSync('/bin/sh'))})`);
  });

  it('does not silently expose configured read-only folders outside the user home', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    const externalSkills = tempDir();
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'run_external_read',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      readOnlyFolders: [externalSkills],
    });

    expect(workspace.readOnlyRoots).not.toContain(fs.realpathSync(externalSkills));
    expect(workspace.readRoots).not.toContain(fs.realpathSync(externalSkills));

    const explicitlyGranted = createRunWorkspace({
      id: 'run_explicit_external_read',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      readOnlyFolders: [externalSkills],
      allowExternalReadOnlyFolders: true,
    });
    expect(explicitlyGranted.readOnlyRoots).toContain(fs.realpathSync(externalSkills));
    expect(explicitlyGranted.readRoots).toContain(fs.realpathSync(externalSkills));
    expect(explicitlyGranted.writeRoots).not.toContain(fs.realpathSync(externalSkills));
  });
});
