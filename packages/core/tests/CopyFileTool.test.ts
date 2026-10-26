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
  // A copy into an ordinary home folder is routine.
  expect(tool.assessRisk(input, ctx)).toEqual({ escalate: false, routine: true });
  const result = await tool.execute(input, ctx);
  expect(result.isError).toBeUndefined();
  expect(fs.readFileSync(path.join(home, 'tempfiles', 'report.bin'))).toEqual(Buffer.from([0, 255, 1, 254]));
});

it('asks before copying out of a credential store, offering a persistent read grant', () => {
  const { home, ctx } = setup();
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
  const risk = new CopyFileTool().assessRisk({ source: '~/.ssh/id_ed25519', destination: '~/tempfiles/key' }, ctx);
  expect(risk).toMatchObject({ escalate: true, sensitiveGrant: '~/.ssh' });
  expect(risk.runGrantFolder).toBeUndefined();
});

it('keeps the replaced file in the Trash', async () => {
  const { home, rootDir, ctx } = setup();
  const source = path.join(rootDir, 'output', 'new.txt');
  fs.writeFileSync(source, 'new');
  fs.mkdirSync(path.join(home, 'docs'));
  fs.writeFileSync(path.join(home, 'docs', 'a.txt'), 'old');
  const result = await new CopyFileTool().execute({ source, destination: '~/docs/a.txt' }, ctx);
  expect(result.isError, result.content).toBeUndefined();
  expect(fs.readFileSync(path.join(home, 'docs', 'a.txt'), 'utf8')).toBe('new');
  expect(fs.readdirSync(path.join(home, 'docs'))).toEqual(['a.txt']);
  const trashed = trashEntries(home);
  expect(trashed).toHaveLength(1);
  expect(trashed[0].content).toBe('old');
});

/** Items moved to this test home's Trash (macOS .Trash or the XDG layout). */
function trashEntries(home: string): Array<{ name: string; content: string }> {
  const dir = process.platform === 'darwin' ? path.join(home, '.Trash') : path.join(home, '.local', 'share', 'Trash', 'files');
  return fs.readdirSync(dir).map(name => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
}
