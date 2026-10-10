import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/app/AppStore';
import { resolveHostReadGrant } from '../src/app/HostReadGrants';
import { compileSkillApp } from '../src/app/SkillAppCompiler';
import { SkillAppInstanceRegistry } from '../src/app/SkillAppInstanceRegistry';
import type { SkillAppInstanceRuntime, SkillAppInteractionHandlers } from '../src/app/SkillAppInstanceRegistry';
import type { SkillAppResult } from '../src/app/SkillAppSchema';
import { parseSkill } from '../src/skill/SkillValidator';

const tempDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const ok = (text: string): SkillAppResult => ({
  status: 'ok',
  data: { text },
  meta: { engine: 'test', model: 'test', durationMs: 1 },
});

describe('SkillApp executions', () => {
  it('runs a state-selected Skill as a cancellable execution and drops its late result', async () => {
    const definition = compileSkillApp(painersRoomSource(), 'painers-room/skillapp.ts');
    definition.operations[0].requiredInputs = ['promptMaker', 'idea'];
    const calls: Array<{ state: Record<string, string>; signal?: AbortSignal; interactions?: SkillAppInteractionHandlers }> = [];
    let settle: (result: SkillAppResult) => void = () => {};
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: (_app, _operation, state, signal, _history, _attachments, interactions) => {
        calls.push({ state, signal, interactions });
        return new Promise(resolve => { settle = resolve; });
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');

    // The start request carries input that no state update has delivered yet.
    const started = registry.start(instance.id, 'makePrompt', {
      promptMaker: 'make-midjourney-prompt',
      idea: 'a lighthouse',
    });
    expect(started).toMatchObject({
      status: 'running',
      instance: {
        state: { promptMaker: 'make-midjourney-prompt', idea: 'a lighthouse', result: '' },
        execution: { operation: 'makePrompt', phase: 'running', cancellable: true },
      },
    });
    expect(calls[0]?.state).toMatchObject({ promptMaker: 'make-midjourney-prompt', idea: 'a lighthouse' });
    // Ordinary runs never receive the interactive question/approval handlers.
    expect(calls[0]?.interactions).toBeUndefined();
    await expect(registry.update(instance.id, { idea: 'other' })).rejects.toThrow(/still active/);

    const executionId = started.instance.execution!.id;
    const cancelled = registry.cancelExecution(instance.id, executionId);
    expect(cancelled.execution).toMatchObject({ id: executionId, phase: 'cancelled', cancellable: false });
    expect(calls[0]?.signal?.aborted).toBe(true);
    settle(ok('LATE'));
    await new Promise(resolve => setImmediate(resolve));
    expect(registry.get(instance.id)).toMatchObject({
      state: { result: '' },
      execution: { id: executionId, phase: 'cancelled' },
    });

    // The blocking compatibility form waits for the same execution lifecycle.
    const blocking = registry.run(instance.id, 'makePrompt');
    settle(ok('A LIGHTHOUSE'));
    expect(await blocking).toMatchObject({
      status: 'completed',
      operation: 'makePrompt',
      instance: { state: { result: 'A LIGHTHOUSE' }, execution: { phase: 'completed' } },
      result: { status: 'ok' },
    });
    registry.close();
  });

  it('reports a cancelled blocking run as superseded', async () => {
    const definition = compileSkillApp(painersRoomSource(), 'painers-room/skillapp.ts');
    definition.operations[0].requiredInputs = ['idea'];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: (_app, _operation, _state, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    await registry.update(instance.id, { idea: 'storm' });
    const blocking = registry.run(instance.id, 'makePrompt');
    const executionId = registry.get(instance.id).execution!.id;
    registry.cancelExecution(instance.id, executionId);
    expect(await blocking).toMatchObject({ status: 'superseded', operation: 'makePrompt' });
    registry.close();
  });
});

describe('SkillApp catalog and layout', () => {
  it('lists bundles that fail to load with their exact error', () => {
    const appsDir = temporaryDirectory();
    fs.mkdirSync(path.join(appsDir, 'broken-app'));
    fs.writeFileSync(path.join(appsDir, 'broken-app', 'skillapp.ts'), 'export default 42;\n');
    fs.mkdirSync(path.join(appsDir, 'empty-folder'));
    const catalog = new AppStore(appsDir).listCatalog();
    expect(catalog.apps).toEqual([]);
    expect(catalog.invalid).toEqual([{
      name: 'broken-app',
      code: 'APP_INVALID',
      message: expect.stringMatching(/\S/),
    }]);
    expect(new AppStore(appsDir).list()).toEqual([]);
  });

  it('compiles Row and Column alignment and rejects between on a Column', () => {
    const source = painersRoomSource().replace("gap: 'medium',", "gap: 'medium',\n        align: 'between',");
    const row = compileSkillApp(source, 'painers-room/skillapp.ts').layout[0]!.children!
      .find(item => item.align !== undefined);
    expect(row).toMatchObject({ component: 'row', align: 'between' });
    const column = (align: string) => compileSkillApp(
      painersRoomSource().replace("      gap: 'large',\n", `      gap: 'large',\n      align: '${align}',\n`),
      'painers-room/skillapp.ts',
    );
    expect(column('center').layout[0]).toMatchObject({ component: 'column', align: 'center' });
    expect(() => column('between')).toThrow(/Invalid column alignment 'between'/);
  });
});

describe('Skill-declared reads', () => {
  it('accepts absolute and ~/ file reads and rejects relative ones', () => {
    const skill = parseSkill('---\nname: reader\nreads:\n  - ~/Prompts/vars.toml\n  - /opt/shared/look.toml\n---\nRead the shared vars.\n');
    expect(skill.reads).toEqual(['~/Prompts/vars.toml', '/opt/shared/look.toml']);
    expect(() => parseSkill('---\nname: reader\nreads:\n  - vars.toml\n---\nRead.\n'))
      .toThrow(/must be an absolute or ~\/ file path/);
    expect(() => parseSkill('---\nname: reader\nreads: ~/vars.toml\n---\nRead.\n'))
      .toThrow(/"reads" to be a list/);
  });

  it('grants only regular files outside private and sensitive state', () => {
    const home = temporaryDirectory();
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(home, 'Prompts'));
    fs.writeFileSync(path.join(home, 'Prompts', 'vars.toml'), 'look = "soft"\n');
    fs.mkdirSync(path.join(home, '.marifold'));
    fs.writeFileSync(path.join(home, '.marifold', 'config.toml'), 'api_key = "secret"\n');
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'private key');
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'aws_secret_access_key = x');
    fs.writeFileSync(path.join(home, '.netrc'), 'machine x password y');
    const grant = (declared: string) => resolveHostReadGrant({
      declared,
      kind: 'file',
      label: "Skill 'reader' declared",
      noun: 'read',
    });
    expect(grant('~/Prompts/vars.toml')).toBe(fs.realpathSync(path.join(home, 'Prompts', 'vars.toml')));
    expect(() => grant('~/Prompts')).toThrow(/not a regular file/);
    expect(() => grant('~/.marifold/config.toml')).toThrow(/Marifold private state/);
    expect(() => grant('~/.ssh/id_ed25519')).toThrow(/sensitive account data/);
    expect(() => grant('~/.aws/credentials')).toThrow(/sensitive account data/);
    expect(() => grant('~/.netrc')).toThrow(/sensitive account data/);
    expect(() => grant('Prompts/vars.toml')).toThrow(/absolute or ~\/ path/);
  });
});

function painersRoomSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), '../../examples/apps/painers-room/skillapp.ts'),
    'utf-8',
  );
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skillapp-runs-'));
  tempDirectories.push(directory);
  return directory;
}
