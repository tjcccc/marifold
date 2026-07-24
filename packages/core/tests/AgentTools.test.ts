import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DelegateTool } from '../src/agent/tools/DelegateTool';
import { PythonPackageTool } from '../src/agent/tools/PythonPackageTool';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';
import { ShellExecTool } from '../src/agent/tools/ShellExecTool';
import { isInsideWorkspace, WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { createRunWorkspace } from '../src/agent/RunWorkspace';
import { capToolOutput, ToolExecutionContext, ToolRegistry } from '../src/agent/ToolRegistry';
import {
  ensurePythonEnvironment,
  findExecutable,
  pythonInVenv,
  runScopedProcess,
} from '../src/agent/ScopedProcess';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function context(cwd: string, outputLimit = 100000): ToolExecutionContext {
  return { cwd, outputLimit };
}

function scopedContext(cwd: string, outputLimit = 100000): ToolExecutionContext {
  const container = path.dirname(cwd);
  return {
    cwd,
    outputLimit,
    workspace: createRunWorkspace({
      id: 'tool_test',
      cwd,
      runsDir: path.join(container, '.marifold-test', 'runs'),
      userHome: container,
    }),
  };
}

describe('ToolRegistry', () => {
  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    expect(() => registry.register(new ReadFileTool())).toThrow(/already registered/);
  });

  it('caps tool output with a truncation marker', () => {
    expect(capToolOutput('abcdef', 3)).toContain('abc');
    expect(capToolOutput('abcdef', 3)).toContain('truncated');
    expect(capToolOutput('abc', 10)).toBe('abc');
  });

  it('keeps head AND tail when capping a large output', () => {
    const content = `HEAD${'x'.repeat(100)}TAIL`;
    const out = capToolOutput(content, 20);
    expect(out).toContain('HEAD');
    expect(out).toContain('TAIL'); // the end survives, unlike head-only truncation
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(content.length);
  });
});

describe('ReadFileTool', () => {
  it('reads files relative to cwd', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello agent');
    const result = await new ReadFileTool().execute({ path: 'a.txt' }, context(dir));
    expect(result.content).toBe('hello agent');
    expect(result.isError, result.content).toBeFalsy();
  });

  it('returns an error result for missing files', async () => {
    const result = await new ReadFileTool().execute({ path: 'missing.txt' }, context(tempDir()));
    expect(result.isError).toBe(true);
  });

  it('lists directories', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    const result = await new ReadFileTool().execute({ path: '.' }, context(dir));
    expect(result.content).toContain('b.txt');
  });

  it('allows app-owned skill reads without exposing other Marifold state', () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    const skillDir = path.join(home, '.marifold', 'profiles', 'painter', 'skills', 'prompt-maker');
    const skillFile = path.join(skillDir, 'SKILL.md');
    const profileConfig = path.join(home, '.marifold', 'profiles', 'painter', 'profile.toml');
    fs.mkdirSync(cwd);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, '# Skill');
    fs.writeFileSync(profileConfig, 'name = "painter"');
    const workspace = createRunWorkspace({
      id: 'tool_skill_read',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      readOnlyFolders: [path.dirname(skillDir)],
    });
    const ctx: ToolExecutionContext = { cwd, outputLimit: 100000, workspace };
    const tool = new ReadFileTool();

    expect(tool.assessRisk({ path: skillFile }, ctx)).toEqual({ escalate: false });
    expect(tool.assessRisk({ path: profileConfig }, ctx)).toMatchObject({
      escalate: true,
      persistable: false,
    });
  });
});

describe('WriteFileTool', () => {
  it('writes inside the workspace and creates parent directories', async () => {
    const dir = tempDir();
    const tool = new WriteFileTool();
    const result = await tool.execute({ path: 'notes/today.md', content: 'hi' }, context(dir));
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'notes/today.md'), 'utf-8')).toBe('hi');
  });

  it('escalates writes outside the workspace', () => {
    const dir = tempDir();
    const outside = tempDir();
    const tool = new WriteFileTool();
    const risk = tool.assessRisk({ path: path.join(outside, 'x.txt'), content: 'x' }, context(dir));
    expect(risk.escalate).toBe(true);
    expect(risk.reason).toContain('outside');

    const inside = tool.assessRisk({ path: 'x.txt', content: 'x' }, context(dir));
    expect(inside.escalate).toBe(false);
  });

  it('treats a write in a trusted folder as non-escalated and trusted', () => {
    const dir = tempDir();
    const trusted = tempDir();
    const tool = new WriteFileTool();
    const ctx: ToolExecutionContext = { ...context(dir), trustedFolders: [trusted] };

    const inTrusted = tool.assessRisk({ path: path.join(trusted, 'blog.md'), content: 'x' }, ctx);
    expect(inTrusted.escalate).toBe(false);
    expect(inTrusted.trusted).toBe(true);

    // A trusted folder that is also the cwd (e.g. a channel's outbox) is still
    // trusted — auto-approved, not merely non-escalated. Checked before the
    // workspace so write=ask doesn't prompt for it.
    const asCwd: ToolExecutionContext = { ...context(trusted), trustedFolders: [trusted] };
    const inCwdTrusted = tool.assessRisk({ path: 'report.md', content: 'x' }, asCwd);
    expect(inCwdTrusted.trusted).toBe(true);

    // A path in neither the workspace nor a trusted folder still escalates,
    // and exposes its target so a client can offer to trust the folder.
    const elsewhere = tempDir();
    const risk = tool.assessRisk({ path: path.join(elsewhere, 'x.md'), content: 'x' }, ctx);
    expect(risk.escalate).toBe(true);
    expect(risk.targetPath).toBe(path.join(elsewhere, 'x.md'));
  });

  it('expands ~ in read and write paths', async () => {
    const dir = tempDir();
    const home = os.homedir();
    // Risk assessment must see the expanded home path, not "$cwd/~/...".
    const risk = new WriteFileTool().assessRisk({ path: '~/somewhere/x.txt', content: 'x' }, context(dir));
    expect(risk.escalate).toBe(true);
    expect(risk.reason).toContain(home);

    const result = await new ReadFileTool().execute({ path: '~/nonexistent-marifold-test-file' }, context(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain(home);
    expect(result.content).not.toContain('/~/');
  });

  it('isInsideWorkspace handles traversal and absolute paths', () => {
    expect(isInsideWorkspace('/tmp/ws/a/b.txt', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/ws', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/other/b.txt', '/tmp/ws')).toBe(false);
    expect(isInsideWorkspace('/tmp/ws/../escape.txt', '/tmp/ws')).toBe(false);
  });
});

describe('ShellExecTool', () => {
  it.skipIf(process.platform !== 'darwin')('runs commands in cwd with a synthetic home and captures output', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    const ctx = scopedContext(dir);
    const result = await new ShellExecTool().execute({ command: 'ls; printf "\\nhome=$HOME"' }, ctx);
    expect(result.content).toContain('c.txt');
    expect(result.content).toContain(`home=${ctx.workspace!.homeDir}`);
    expect(result.isError).toBeFalsy();
  });

  it.skipIf(process.platform !== 'darwin')('flags failing commands as errors', async () => {
    const dir = tempDir();
    const result = await new ShellExecTool().execute({ command: 'exit 3' }, scopedContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('3');
  });

  it.skipIf(process.platform !== 'darwin')('allows signals only within the sandboxed process tree', async () => {
    const dir = tempDir();
    const result = await new ShellExecTool().execute(
      { command: "sh -c 'sleep 5' & child=$!; kill \"$child\"; wait \"$child\" 2>/dev/null || true; printf ok" },
      scopedContext(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('ok');
  });

  it.skipIf(process.platform !== 'darwin' || !findExecutable('uv'))('creates and uses the disposable Python environment', async () => {
    const dir = tempDir();
    const ctx = scopedContext(dir);
    const result = await new ShellExecTool().execute({ command: 'python --version' }, ctx);
    expect(result.isError, result.content).toBeFalsy();
    expect(result.content).toMatch(/Python \d/);
    expect(fs.existsSync(path.join(ctx.workspace!.venvDir, 'bin', 'python'))).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('blocks host writes outside the workspace even after execution is approved', async () => {
    const parent = tempDir();
    const dir = path.join(parent, 'workspace');
    fs.mkdirSync(dir);
    const outside = path.join(parent, 'outside.txt');
    const result = await new ShellExecTool().execute(
      { command: `printf unsafe > ${JSON.stringify(outside)}` },
      scopedContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('fails closed without an isolated run workspace', async () => {
    const result = await new ShellExecTool().execute({ command: 'printf unsafe' }, context(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('without an isolated run workspace');
  });
});

describe('PythonPackageTool', () => {
  it('always escalates without allowing a persistent grant', () => {
    const risk = new PythonPackageTool().assessRisk({ packages: ['openpyxl'] }, context(tempDir()));
    expect(risk).toMatchObject({ escalate: true, persistable: false });
  });

  it('refuses URL and flag requirements before invoking uv', async () => {
    const dir = tempDir();
    const result = await new PythonPackageTool().execute(
      { packages: ['--system', 'https://example.test/pkg.whl'] },
      scopedContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refused unsafe Python requirement');
  });

  it.skipIf(process.platform !== 'darwin' || !findExecutable('uv'))('hides run inputs from network-enabled package build hooks', async () => {
    const dir = tempDir();
    const ctx = scopedContext(dir);
    const workspace = ctx.workspace!;
    const secret = path.join(workspace.inputDir, 'private.txt');
    fs.writeFileSync(secret, 'must-not-leak');
    const environmentError = await ensurePythonEnvironment(workspace, ctx.outputLimit);
    expect(environmentError).toBeUndefined();
    const installerRoots = [
      workspace.workDir,
      workspace.homeDir,
      workspace.tempDir,
      workspace.cacheDir,
      workspace.venvDir,
    ];
    const result = await runScopedProcess({
      executable: pythonInVenv(workspace),
      args: ['-c', `print(open(${JSON.stringify(secret)}).read())`],
      workspace,
      cwd: workspace.workDir,
      readRoots: installerRoots,
      writeRoots: installerRoots,
      network: true,
      outputLimit: ctx.outputLimit,
      successSummary: 'unexpectedly read private input',
      failureSummary: 'private input stayed hidden',
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('must-not-leak');
  });
});

describe('DelegateTool', () => {
  it('rejects unknown profiles without calling ask', async () => {
    let asked = 0;
    const tool = new DelegateTool({
      ask: async () => { asked += 1; return { ok: true, text: 'x' }; },
      listProfileNames: () => ['default', 'translator'],
    });
    const result = await tool.execute({ profile: 'nope', prompt: 'hi' }, context(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('translator');
    expect(asked).toBe(0);
  });

  it('returns the delegated profile reply', async () => {
    const tool = new DelegateTool({
      ask: async request => ({ ok: true, text: `translated: ${request.prompt}` }),
      listProfileNames: () => ['translator'],
    });
    const result = await tool.execute({ profile: 'translator', prompt: 'hello' }, context(tempDir()));
    expect(result.content).toBe('translated: hello');
    expect(result.isError).toBeFalsy();
  });
});
