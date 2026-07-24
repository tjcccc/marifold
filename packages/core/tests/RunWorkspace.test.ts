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

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-run-workspace-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('RunWorkspace', () => {
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
    expect(workspace.files[0].name).toBe('budget.xlsx');
    expect(fs.readFileSync(workspace.files[0].path, 'utf8')).toBe('xlsx-bytes');
    expect(fs.statSync(workspace.files[0].path).mode & 0o222).toBe(0);
    expect(resolveToolPath('~/note.txt', workspace, cwd)).toBe(path.join(workspace.homeDir, 'note.txt'));
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
  });
});
