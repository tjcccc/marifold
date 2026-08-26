import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { listRunArtifacts } from '../src/agent/RunArtifacts';
import { createRunWorkspace } from '../src/agent/RunWorkspace';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('run artifacts', () => {
  it('lists regular nested output files with stable opaque IDs and media types', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'artifact_listing',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    fs.mkdirSync(path.join(workspace.outputDir, 'reports'));
    fs.writeFileSync(path.join(workspace.outputDir, 'reports', 'joined.xlsx'), 'xlsx');
    fs.writeFileSync(path.join(workspace.outputDir, 'summary.pdf'), 'pdf');

    const first = listRunArtifacts(workspace);
    const second = listRunArtifacts(workspace);

    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({ name: 'summary.pdf', mediaType: 'application/pdf', size: 3 }),
      expect.objectContaining({
        name: 'reports/joined.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 4,
      }),
    ]);
    expect(first.every(artifact => /^[a-f0-9]{24}$/.test(artifact.id))).toBe(true);
  });

  it('never exposes output symlinks', () => {
    if (process.platform === 'win32') return;
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'artifact_symlink',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    const privateFile = path.join(home, 'private.txt');
    fs.writeFileSync(privateFile, 'private');
    fs.symlinkSync(privateFile, path.join(workspace.outputDir, 'leak.txt'));

    expect(listRunArtifacts(workspace)).toEqual([]);
  });
});
