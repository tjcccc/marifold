import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunWorkspace } from '../src/agent/RunWorkspace';
import { CopyFileTool } from '../src/agent/tools/CopyFileTool';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); } });

function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-copy-')));
  dirs.push(home);
  const rootDir = path.join(home, '.run');
  fs.mkdirSync(path.join(rootDir, 'output'), { recursive: true });
  const workspace = { userHome: home, rootDir, cwd: rootDir, readRoots: [rootDir], writeRoots: [rootDir], readOnlyFiles: [], deniedRoots: [] } as unknown as RunWorkspace;
  return { home, rootDir, ctx: { cwd: rootDir, outputLimit: 1000, workspace } };
}

it('copies a binary file into an existing folder outside the run', async () => {
  const { home, rootDir, ctx } = setup();
  const source = path.join(rootDir, 'output', 'report.bin');
  fs.writeFileSync(source, Buffer.from([0, 255, 1, 254]));
  fs.mkdirSync(path.join(home, 'tempfiles'));
  const tool = new CopyFileTool();
  const input = { source, destination: '~/tempfiles' };
  // Only the destination is outside the run, so its folder can be granted.
  expect(tool.assessRisk(input, ctx)).toMatchObject({ escalate: true, runGrantFolder: path.join(home, 'tempfiles') });
  const result = await tool.execute(input, ctx);
  expect(result.isError).toBeUndefined();
  expect(fs.readFileSync(path.join(home, 'tempfiles', 'report.bin'))).toEqual(Buffer.from([0, 255, 1, 254]));
});

it('offers no folder grant when the source is outside the run', () => {
  const { home, ctx } = setup();
  fs.mkdirSync(path.join(home, 'docs'));
  fs.writeFileSync(path.join(home, 'docs', 'a.txt'), 'a');
  const risk = new CopyFileTool().assessRisk({ source: '~/docs/a.txt', destination: '~/tempfiles/a.txt' }, ctx);
  expect(risk.escalate).toBe(true);
  expect(risk.runGrantFolder).toBeUndefined(); // a write grant must never cover the source folder
});
