import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coveredByRunGrant, type ApprovalRequest } from '../src/agent/ApprovalPolicy';
import { runGrantFolder, type RunWorkspace } from '../src/agent/RunWorkspace';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });
function home(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-run-grants-')));
  dirs.push(dir);
  return dir;
}
function workspace(userHome: string, deniedRoots: string[] = []): RunWorkspace {
  return { userHome, deniedRoots, rootDir: path.join(userHome, '.run'), cwd: userHome } as unknown as RunWorkspace;
}

describe('runGrantFolder', () => {
  it('grants the parent folder inside home and nothing broader or sensitive', () => {
    const userHome = home();
    const ws = workspace(userHome, [path.join(userHome, 'stacks', 'state')]);
    expect(runGrantFolder(path.join(userHome, 'stacks', 'skills', 'a.md'), ws)).toBe(path.join(userHome, 'stacks', 'skills'));
    expect(runGrantFolder(path.join(userHome, 'notes.md'), ws)).toBeUndefined(); // home itself
    expect(runGrantFolder(path.join(userHome, '.ssh', 'config'), ws)).toBeUndefined(); // sensitive
    expect(runGrantFolder(path.join(userHome, '.config', 'gh', 'hosts.yml'), ws)).toBeUndefined();
    expect(runGrantFolder(path.join(userHome, 'stacks', 'state', 'x.json'), ws)).toBeUndefined(); // denied root
    expect(runGrantFolder(path.join(userHome, 'stacks', 'a.md'), ws)).toBeUndefined(); // contains a denied root
    expect(runGrantFolder('/etc/hosts', ws)).toBeUndefined(); // outside home
  });

  it('is offered by read_file only for persistable in-home escalations', () => {
    const userHome = home();
    const ws = workspace(userHome);
    const tool = new ReadFileTool();
    const risk = tool.assessRisk({ path: path.join(userHome, 'docs', 'a.md') }, { cwd: userHome, outputLimit: 1000, workspace: { ...ws, readRoots: [], readOnlyFiles: [] } as never });
    expect(risk).toMatchObject({ escalate: true, runGrantFolder: path.join(userHome, 'docs') });
    const outside = tool.assessRisk({ path: '/etc/hosts' }, { cwd: userHome, outputLimit: 1000, workspace: { ...ws, readRoots: [], readOnlyFiles: [] } as never });
    expect(outside.runGrantFolder).toBeUndefined();
  });
});

describe('coveredByRunGrant', () => {
  const request = (overrides: Partial<ApprovalRequest>): ApprovalRequest => ({
    id: 'r', tool: 'read_file', kind: 'read', summary: 's', input: {}, escalated: true,
    escalatedPath: '/home/u/docs/a.md', runGrant: { folder: '/home/u/docs', access: 'read' }, ...overrides,
  });

  it('matches by folder and access, and never without the tool marker or for sudo', () => {
    const read = [{ folder: '/home/u/docs', access: 'read' as const }];
    const write = [{ folder: '/home/u/docs', access: 'write' as const }];
    expect(coveredByRunGrant(request({}), read)).toBe(true);
    expect(coveredByRunGrant(request({ escalatedPath: '/home/u/docs/sub/b.md' }), read)).toBe(true);
    expect(coveredByRunGrant(request({ escalatedPath: '/home/u/docs-other/b.md' }), read)).toBe(false);
    expect(coveredByRunGrant(request({ kind: 'write', runGrant: { folder: '/home/u/docs', access: 'write' } }), read)).toBe(false);
    expect(coveredByRunGrant(request({}), write)).toBe(true);
    expect(coveredByRunGrant(request({ runGrant: undefined }), read)).toBe(false);
    expect(coveredByRunGrant(request({ sudo: { id: 'x' } as never }), read)).toBe(false);
  });
});
