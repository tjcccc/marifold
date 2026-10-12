import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import { AgentComputer, upstreamFor } from '../src/computer/AgentComputer';
import { agentComputerTools, ComputerPutTool, mentionsAgentComputer } from '../src/computer/ComputerTools';

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

  it('offers its tools only to profiles that have a computer', () => {
    const configDir = tempDir();
    const computer = new AgentComputer(path.join(configDir, 'config.toml'), '/nonexistent/docker');
    expect(agentComputerTools(computer, 'writer')).toEqual([]);
    fs.writeFileSync(path.join(configDir, 'agent-computer.json'), JSON.stringify({ settings: {}, computers: { writer: { createdAt: 1 } } }));
    expect(agentComputerTools(computer, 'writer').map(tool => tool.definition.name)).toEqual(['computer_exec', 'computer_write_file', 'computer_put', 'computer_get']);
    expect(agentComputerTools(computer, 'painter')).toEqual([]);
    expect(() => computer.containerName('Bad Name')).toThrow();
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
});
