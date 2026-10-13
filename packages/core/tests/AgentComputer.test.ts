import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import { AgentComputer, upstreamFor } from '../src/computer/AgentComputer';
import { accountNameProblem, nextAccountUid, reconcileInput } from '../src/computer/AgentComputerAccounts';
import { agentComputerTools, ComputerPutTool, mentionsAgentComputer } from '../src/computer/ComputerTools';
import { choosePlatform, parseImageReference } from '../src/computer/ImageDownload';
import { newProfileNameProblem } from '../src/profiles/ProfileName';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-computer-')));
  dirs.push(dir);
  return dir;
}

describe('agent computer', () => {
  it('maps the user proxy to an address the egress container can reach', () => {
    expect(upstreamFor('http://127.0.0.1:7890')).toBe('host.docker.internal:7890');
    expect(upstreamFor('http://localhost:7890/')).toBe('host.docker.internal:7890');
    expect(upstreamFor('http://192.168.50.5:7890')).toBe('192.168.50.5:7890');
    for (const bad of ['socks5://127.0.0.1:7890', 'http://u:p@127.0.0.1:7890', 'http://127.0.0.1', '127.0.0.1:7890', 'http://127.0.0.1:7890/path']) {
      expect(() => upstreamFor(bad), bad).toThrow();
    }
  });

  it('offers its tools only to profiles with access to an existing computer', () => {
    const configDir = tempDir();
    const computer = new AgentComputer(path.join(configDir, 'config.toml'), '/nonexistent/docker');
    const state = (value: object) => fs.writeFileSync(path.join(configDir, 'agent-computer.json'), JSON.stringify(value));
    const accounts = { writer: { uid: 2000, access: true, createdAt: 1 }, painter: { uid: 2001, access: false, createdAt: 1 } };
    state({ settings: {}, accounts });
    expect(agentComputerTools(computer, 'writer')).toEqual([]);
    state({ settings: {}, computer: { createdAt: 1 }, accounts });
    expect(agentComputerTools(computer, 'writer').map(tool => tool.definition.name)).toEqual(['computer_exec', 'computer_write_file', 'computer_put', 'computer_get']);
    expect(agentComputerTools(computer, 'painter')).toEqual([]);
    // Per-profile computers from before 0.90 grant nothing.
    state({ settings: {}, computers: { writer: { createdAt: 1 } } });
    expect(agentComputerTools(computer, 'writer')).toEqual([]);
  });

  it('accepts only new profile names that can be account names', () => {
    for (const name of ['writer', 'dev_test', 'x-runner', `a${'b'.repeat(31)}`]) { expect(newProfileNameProblem(name), name).toBeUndefined(); }
    for (const name of ['Writer', '1writer', '-x', `a${'b'.repeat(32)}`, 'root', 'ubuntu', 'marifold-agents']) { expect(newProfileNameProblem(name), name).toBeDefined(); }
    expect(accountNameProblem('MyBot')).toContain('marifold profile rename MyBot');
    expect(newProfileNameProblem('marifold')).toBeDefined();
    expect(reconcileInput({ default: { uid: 2000, access: true, createdAt: 1 }, writer: { uid: 2001, access: false, createdAt: 1 } }, [{ uid: 2002, name: 'gone' }]))
      .toBe('rm 2002 gone\nadd 2000 marifold\nadd 2001 writer\n');
    expect(nextAccountUid({ a: { uid: 2004, access: true, createdAt: 1 } }, [{ uid: 2007, name: 'gone' }])).toBe(2008);
    expect(nextAccountUid({}, [])).toBe(2000);
  });

  it('recognizes requests about the agent computer, not the user\'s', () => {
    for (const text of ['install ffmpeg on your computer', 'use your own linux machine to build it', 'run it on the agent computer', 'in your sandbox', '用你的电脑跑一下', '在你自己的虚拟机里安装']) {
      expect(mentionsAgentComputer(text), text).toBe(true);
    }
    for (const text of ['restart tailscale on my computer', 'computer science homework', 'check the office computer', '我的电脑']) {
      expect(mentionsAgentComputer(text), text).toBe(false);
    }
  });

  it('never sends credentials or Marifold state, even with approval', () => {
    const home = tempDir();
    const workspace = { userHome: home, rootDir: path.join(home, '.marifold', 'runs', 'r1'), deniedRoots: [], readRoots: [], readOnlyFiles: [], cwd: home } as unknown as RunWorkspace;
    for (const dir of ['.ssh', '.marifold/runs/r1', 'Documents/brief']) { fs.mkdirSync(path.join(home, dir), { recursive: true }); }
    const put = new ComputerPutTool({} as AgentComputer, 'writer');
    const assess = (source: string) => put.assessRisk({ source }, { cwd: home, outputLimit: 1000, workspace });
    for (const source of ['~/.ssh', '~/.ssh/id_ed25519', '~/.marifold', '~', '~/.config/gh/hosts.yml']) {
      expect(assess(source), source).toMatchObject({ blocked: true });
    }
    expect(assess('~/Documents/brief')).toMatchObject({ escalate: true });
    expect(assess(path.join(workspace.rootDir, 'out.txt'))).not.toMatchObject({ blocked: true });
  });

  it('names images the way Docker does when downloading them through the proxy', () => {
    expect(parseImageReference('ubuntu:24.04')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/ubuntu', reference: '24.04', name: 'docker.io/library/ubuntu:24.04' });
    expect(parseImageReference('someone/tool')).toMatchObject({ repository: 'someone/tool', reference: 'latest' });
    expect(parseImageReference('mirror.example.com:5000/library/ubuntu:24.04')).toMatchObject({ registry: 'mirror.example.com:5000', repository: 'library/ubuntu', reference: '24.04' });
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseImageReference(`ubuntu@${digest}`)).toMatchObject({ repository: 'library/ubuntu', reference: digest });
    const manifests = [
      { mediaType: 'm', digest: 'amd', size: 1, platform: { os: 'linux', architecture: 'amd64' } },
      { mediaType: 'm', digest: 'v7', size: 1, platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
      { mediaType: 'm', digest: 'arm64', size: 1, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
    ];
    expect(choosePlatform(manifests, 'linux/arm64')?.digest).toBe('arm64');
    expect(choosePlatform(manifests, 'linux/amd64')?.digest).toBe('amd');
    expect(choosePlatform(manifests, 'linux/riscv64')).toBeUndefined();
  });
});
