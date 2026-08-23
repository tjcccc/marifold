import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../src/app/AppStore';
import { compileSkillApp } from '../src/app/SkillAppCompiler';
import { SkillAppInstanceRegistry } from '../src/app/SkillAppInstanceRegistry';
import type { SkillAppInstanceRuntime } from '../src/app/SkillAppInstanceRegistry';
import type { SkillAppDefinition, SkillAppResult } from '../src/app/SkillAppSchema';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SkillApp v1', () => {
  it('statically compiles the translator template without executing it', () => {
    const source = translatorSource();
    const definition = compileSkillApp(source, 'translator/skillapp.ts');
    expect(definition).toMatchObject({
      schema: 'marifold.skillapp.v1',
      app: { name: 'translator', title: 'Marifold Translation' },
      models: [{ provider: 'ollama', model: 'maternion/hy-mt2:1.8b', think: false }],
      skills: [{ name: 'translate', result: { kind: 'text', trim: true } }],
      operations: [{
        name: 'translate',
        parameters: { source_text: 'source', target_language: 'targetLanguage' },
        output: 'result',
        execution: { memory: false, history: false, profileContext: false },
      }],
      triggers: [{ operation: 'translate', debounce: 1000, concurrency: 'latest' }],
    });
    expect(definition.layout[1].children).toMatchObject([
      { component: 'textarea', label: 'Input', bind: 'source', editable: true },
      { component: 'textarea', label: 'Result', bind: 'result', editable: false, copyable: true },
    ]);
  });

  it('rejects arbitrary script logic and imports', () => {
    expect(() => compileSkillApp(
      translatorSource().replace(
        "import {",
        "import fs from 'node:fs';\n\nimport {",
      ),
      'skillapp.ts',
    )).toThrow(/builders only from/);
    expect(() => compileSkillApp(
      translatorSource().replace(
        "trigger(translate, {",
        "setTimeout(() => {}, 1);\n\ntrigger(translate, {",
      ),
      'skillapp.ts',
    )).toThrow(/top-level trigger/);
  });

  it('loads only skillapp.ts and confines Skills to the app bundle', () => {
    const appsDir = temporaryDirectory();
    const bundle = path.join(appsDir, 'translator');
    fs.mkdirSync(path.join(bundle, 'skills', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'skillapp.ts'), translatorSource());
    fs.writeFileSync(
      path.join(bundle, 'skills', 'translate', 'SKILL.md'),
      '---\nname: translate\nvariables:\n  - name: source_text\n    required: true\n  - name: target_language\n    required: true\n---\n{{source_text}} {{target_language}}\n',
    );
    const store = new AppStore(appsDir);
    expect(store.require('translator').schema).toBe('marifold.skillapp.v1');
    expect(store.require('translator')).toMatchObject({
      operations: [{ requiredInputs: ['source', 'targetLanguage'] }],
    });
    expect(store.requireLocalSkillSource('translator', 'translate')).toBe(
      fs.realpathSync(path.join(bundle, 'skills', 'translate', 'SKILL.md')),
    );

    const external = path.join(temporaryDirectory(), 'SKILL.md');
    fs.writeFileSync(external, 'outside');
    fs.rmSync(path.join(bundle, 'skills', 'translate', 'SKILL.md'));
    fs.symlinkSync(external, path.join(bundle, 'skills', 'translate', 'SKILL.md'));
    expect(() => store.requireLocalSkillSource('translator', 'translate')).toThrow(/escapes bundle/);
  });

  it('keeps state in the service runtime and lets the newest trigger win', async () => {
    const definition = compileSkillApp(
      translatorSource().replace('debounce: 1_000', 'debounce: 5'),
      'skillapp.ts',
    );
    definition.operations[0].requiredInputs = ['source'];
    const calls: string[] = [];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async (_app, _operation, state): Promise<SkillAppResult> => {
        calls.push(state.source);
        return {
          status: 'ok',
          data: { text: state.source.toUpperCase() },
          meta: { engine: 'test', model: 'test', durationMs: 1 },
        };
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('translator');
    const first = registry.update(instance.id, { source: 'first' });
    const second = registry.update(instance.id, { source: 'second' });
    expect((await first).status).toBe('superseded');
    const completed = await second;
    expect(completed.status).toBe('completed');
    expect(completed.instance.state.result).toBe('SECOND');
    expect(calls).toEqual(['second']);

    const emptied = await registry.update(instance.id, { source: '   ' });
    expect(emptied).toMatchObject({
      status: 'idle',
      reason: 'missing_required_input',
      operation: 'translate',
      instance: { state: { source: '   ', result: '' } },
    });
    expect((await registry.run(instance.id, 'translate')).reason).toBe('missing_required_input');
    expect(calls).toEqual(['second']);
    registry.close();
  });
});

function translatorSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), '../../examples/apps/translator/skillapp.ts'),
    'utf-8',
  );
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skillapp-'));
  tempDirectories.push(directory);
  return directory;
}
