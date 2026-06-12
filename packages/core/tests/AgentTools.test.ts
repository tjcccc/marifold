import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DelegateTool } from '../src/agent/tools/DelegateTool';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';
import { ShellExecTool } from '../src/agent/tools/ShellExecTool';
import { isInsideWorkspace, WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { capToolOutput, ToolExecutionContext, ToolRegistry } from '../src/agent/ToolRegistry';

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
});

describe('ReadFileTool', () => {
  it('reads files relative to cwd', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello agent');
    const result = await new ReadFileTool().execute({ path: 'a.txt' }, context(dir));
    expect(result.content).toBe('hello agent');
    expect(result.isError).toBeFalsy();
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

  it('isInsideWorkspace handles traversal and absolute paths', () => {
    expect(isInsideWorkspace('/tmp/ws/a/b.txt', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/ws', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/other/b.txt', '/tmp/ws')).toBe(false);
    expect(isInsideWorkspace('/tmp/ws/../escape.txt', '/tmp/ws')).toBe(false);
  });
});

describe('ShellExecTool', () => {
  it('runs commands in cwd and captures output', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    const result = await new ShellExecTool().execute({ command: 'ls' }, context(dir));
    expect(result.content).toContain('c.txt');
    expect(result.isError).toBeFalsy();
  });

  it('flags failing commands as errors', async () => {
    const result = await new ShellExecTool().execute({ command: 'exit 3' }, context(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('3');
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
