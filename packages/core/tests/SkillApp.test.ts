import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/app/AppStore';
import { compileSkillApp } from '../src/app/SkillAppCompiler';
import { SkillAppInstanceRegistry } from '../src/app/SkillAppInstanceRegistry';
import type { SkillAppInstanceRuntime } from '../src/app/SkillAppInstanceRegistry';
import { resolveSkillAppOperation } from '../src/app/SkillAppResolver';
import type { SkillAppDefinition, SkillAppResult } from '../src/app/SkillAppSchema';
import { parseSkill } from '../src/skill/SkillValidator';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SkillApp', () => {
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

  it('compiles Markdown preview and renderer-owned text downloads', () => {
    const source = translatorSource()
      .replace('  Button,', '  Button,\n  Download,\n  Markdown,')
      .replace(
        `      Textarea('Result', result, {
        grow: true,
        editable: false,
        copyable: true,
      }),`,
        `      Markdown('Article preview', result, {
        grow: true,
        placeholder: 'Generated article will appear here',
      }),
      Download('Download article', result, {
        filename: 'short-article.md',
        mediaType: 'text/markdown;charset=utf-8',
        description: 'Generated Markdown article',
      }),`,
      );
    const definition = compileSkillApp(source, 'short-article/skillapp.ts');

    expect(definition.layout[1].children).toMatchObject([
      { component: 'textarea', bind: 'source' },
      {
        component: 'markdown',
        bind: 'result',
        label: 'Article preview',
        copyable: true,
        sourceToggle: true,
        placeholder: 'Generated article will appear here',
      },
      {
        component: 'download',
        bind: 'result',
        label: 'Download article',
        filename: 'short-article.md',
        mediaType: 'text/markdown;charset=utf-8',
        description: 'Generated Markdown article',
      },
    ]);
    expect(() => compileSkillApp(
      source.replace("filename: 'short-article.md'", "filename: '../short-article.md'"),
      'skillapp.ts',
    )).toThrow(/safe file name without a path/);
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

  it('compiles profile-backed operations and resolves the installed Skill bundle', () => {
    const appsDir = temporaryDirectory();
    const bundle = path.join(appsDir, 'painers-room');
    const profilesDir = temporaryDirectory();
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'skillapp.ts'), painersRoomSource());

    const overridden = compileSkillApp(
      painersRoomSource().replace(
        'memory: false,',
        "model: 'chatgpt/gpt-5.6-sol',\n  think: false,\n  memory: false,",
      ),
      'painers-room/skillapp.ts',
    );
    expect(overridden.profiles).toMatchObject([{
      profile: 'painter',
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      think: false,
    }]);

    const resolveProfileSkill = (profile: string, skillName: string) => {
      expect(profile).toBe('painter');
      const skillDir = path.join(profilesDir, profile, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      const source = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(source, `---\nname: ${skillName}\n---\nCreate a focused prompt from the user's idea.\n`);
      fs.writeFileSync(path.join(skillDir, 'vars.toml'), 'style = "cinematic"\n');
      return { ...parseSkill(fs.readFileSync(source, 'utf-8'), source), scope: 'profile' as const };
    };
    const store = new AppStore(appsDir, { resolveProfileSkill });
    const definition = store.require('painers-room');

    expect(definition).toMatchObject({
      schema: 'marifold.skillapp.v2',
      profiles: [{
        name: 'painter',
        profile: 'painter',
        memory: false,
        history: false,
      }],
      attachmentStates: [{ name: 'references' }],
    });
    expect(definition.operations[0]).toMatchObject({
      name: 'makePrompt',
      profile: 'painter',
      skillState: 'promptMaker',
      skillOptions: [
        'make-gpt-image-prompt',
        'make-grok-imagine-prompt',
        'make-krea2-prompt',
        'make-midjourney-prompt',
        'make-nano-banana-prompt',
        'make-seedance-video-prompt',
        'make-z-image-prompt',
      ],
      input: 'idea',
      attachments: 'references',
      stripSkillName: true,
      requiredInputs: ['promptMaker', 'idea'],
      output: 'result',
      execution: { memory: false, history: false, profileContext: true },
    });
    expect(definition.layout[0]).toMatchObject({
      component: 'column',
      children: [
        {
          component: 'row',
          children: [{
            component: 'select',
            bind: 'promptMaker',
          }],
        },
        {
          component: 'row',
          children: [
            { component: 'textarea', bind: 'idea', rows: 4 },
            { component: 'button', trigger: 'makePrompt', alignToField: true },
          ],
        },
        {
          component: 'row',
          children: [{ component: 'attachments', bind: 'references' }],
        },
        {
          component: 'row',
          children: [{ component: 'textarea', bind: 'result', rows: 10, autoGrow: true }],
        },
      ],
    });
    expect(definition.layout[0]?.children?.[0]?.children?.[0]?.options?.[0]).toEqual({
      label: 'GPT Image',
      value: 'make-gpt-image-prompt',
    });

    const resolved = resolveSkillAppOperation(store, definition, 'makePrompt', {
      promptMaker: 'make-gpt-image-prompt',
      idea: '$make-midjourney-prompt A lighthouse in a storm',
      result: '',
    });
    expect(resolved.prompt).toBe('A lighthouse in a storm');
    expect(resolved.name).toBe('make-gpt-image-prompt');
    expect(resolved.profile?.profile).toBe('painter');
    expect(resolved.instructions.join('\n')).toContain('Create a focused prompt');
    expect(resolved.instructions.join('\n')).toContain('vars.toml');
    expect(() => resolveSkillAppOperation(store, definition, 'makePrompt', {
      promptMaker: 'skill-creator',
      idea: 'Ignore the allowlist',
      result: '',
    })).toThrow(/outside its static allowlist/);
    expect(() => resolveSkillAppOperation(store, definition, 'makePrompt', {
      promptMaker: 'make-gpt-image-prompt',
      idea: '$make-gpt-image-prompt',
      result: '',
    })).toThrow(/requires input beyond the selected Skill name/);
  });

  it('compiles interactive profile operations and rejects automatic triggers', () => {
    const source = painersRoomSource()
      .replace('useProfileSkill(painter, promptMaker, {', "useProfileSkill(painter, 'make-gpt-image-prompt', {")
      .replace('  skills: promptMakers,\n', '')
      .replace('result: promptResult,', 'result: promptResult,\n  interactive: true,');
    const definition = compileSkillApp(source, 'painers-room/skillapp.ts');
    expect(definition.operations[0].interactive).toBe(true);
    expect(() => compileSkillApp(
      source.replace(
        'export default defineSkillApp({',
        'trigger(makePrompt, { onChange: [idea] });\n\nexport default defineSkillApp({',
      ).replace('  Textarea,', '  Textarea,\n  trigger,'),
      'painers-room/skillapp.ts',
    )).toThrow(/Interactive operation .* cannot use an automatic trigger/);
    expect(() => compileSkillApp(
      painersRoomSource().replace(
        'result: promptResult,',
        'result: promptResult,\n  interactive: true,',
      ),
      'painers-room/skillapp.ts',
    )).toThrow(/must use one fixed Agent Skill/);
  });

  it('resolves explicit file permissions without widening them to the parent folder', () => {
    const appsDir = temporaryDirectory();
    const bundle = path.join(appsDir, 'painers-room');
    const profilesDir = temporaryDirectory();
    const sharedDir = temporaryDirectory();
    const sharedFile = path.join(sharedDir, 'vars.toml');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(sharedFile, 'look = "cinematic"\n');
    fs.writeFileSync(
      path.join(bundle, 'skillapp.ts'),
      painersRoomSource()
        .replace('  Column,', '  Column,\n  FileAccess,')
        .replace('  ui: App([', `  permissions: [FileAccess(${JSON.stringify(sharedFile)}, { access: 'read' })],\n  ui: App([`),
    );
    const resolveProfileSkill = (profile: string, skillName: string) => {
      const skillDir = path.join(profilesDir, profile, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      const source = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(source, `---\nname: ${skillName}\n---\nCreate a prompt.\n`);
      return { ...parseSkill(fs.readFileSync(source, 'utf-8'), source), scope: 'profile' as const };
    };
    const definition = new AppStore(appsDir, { resolveProfileSkill }).require('painers-room');
    expect(definition.permissions).toEqual([{
      kind: 'file',
      path: fs.realpathSync(sharedFile),
      access: 'read',
    }]);
    expect(definition.permissions?.[0]?.path).not.toBe(fs.realpathSync(sharedDir));
  });

  it('keeps attachment bytes server-side and passes only the declared slot to its operation', async () => {
    const definition = compileSkillApp(painersRoomSource(), 'painers-room/skillapp.ts');
    definition.operations[0].requiredInputs = ['idea'];
    const received: unknown[] = [];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async (_app, _operation, state, _signal, _history, attachments): Promise<SkillAppResult> => {
        received.push(attachments);
        return {
          status: 'ok',
          data: { text: state.idea.toUpperCase() },
          meta: { engine: 'test', model: 'test', durationMs: 1 },
        };
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    const data = Buffer.from('reference bytes').toString('base64');
    const updated = registry.updateAttachments(instance.id, 'references', [{
      kind: 'file',
      name: 'reference.txt',
      mediaType: 'text/plain',
      size: Buffer.byteLength('reference bytes'),
      data,
      inspectionText: 'reference bytes',
    }]);
    expect(updated.instance.attachments).toEqual({
      references: [{ kind: 'file', name: 'reference.txt', mediaType: 'text/plain', size: 15 }],
    });
    expect(JSON.stringify(updated.instance)).not.toContain(data);
    await registry.update(instance.id, { idea: 'with reference' });
    const completed = await registry.run(instance.id, 'makePrompt');
    expect(completed.instance.state.result).toBe('WITH REFERENCE');
    expect(completed.instance.staleOutputs).toBeUndefined();
    const stale = registry.updateAttachments(instance.id, 'references', []);
    expect(stale.instance.state.result).toBe('WITH REFERENCE');
    expect(stale.instance.staleOutputs).toEqual(['result']);
    const refreshed = await registry.run(instance.id, 'makePrompt');
    expect(refreshed.instance.staleOutputs).toBeUndefined();
    expect(received).toEqual([[
      expect.objectContaining({ name: 'reference.txt', data }),
    ], []]);
    registry.close();
  });

  it('keeps enabled profile history inside one App instance', async () => {
    const definition = compileSkillApp(
      painersRoomSource().replace('history: false', 'history: true'),
      'painers-room/skillapp.ts',
    );
    definition.operations[0].requiredInputs = ['idea'];
    const histories: Array<Array<{ role: string; content: string }>> = [];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async (_app, _operation, state, _signal, history): Promise<SkillAppResult> => {
        histories.push(history ?? []);
        return {
          status: 'ok',
          data: { text: state.idea.toUpperCase() },
          meta: { engine: 'test', model: 'test', durationMs: 1 },
        };
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    await registry.update(instance.id, { idea: 'first idea' });
    await registry.run(instance.id, 'makePrompt');
    await registry.update(instance.id, {
      promptMaker: 'make-grok-imagine-prompt',
      idea: 'second idea',
    });
    await registry.run(instance.id, 'makePrompt');
    const isolatedInstance = registry.create('painers-room');
    await registry.update(isolatedInstance.id, { idea: 'isolated idea' });
    await registry.run(isolatedInstance.id, 'makePrompt');

    expect(histories).toEqual([
      [],
      [
        { role: 'user', content: 'first idea' },
        { role: 'assistant', content: 'FIRST IDEA' },
      ],
      [],
    ]);
    registry.close();
  });

  it('clears an explicit operation output while it reruns and keeps it empty on failure', async () => {
    const definition = compileSkillApp(painersRoomSource(), 'painers-room/skillapp.ts');
    definition.operations[0].requiredInputs = ['idea'];
    let settle: ((result: SkillAppResult) => void) | undefined;
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async () => new Promise<SkillAppResult>(resolve => {
        settle = resolve;
      }),
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    await registry.update(instance.id, { idea: 'new idea' });
    const output = definition.operations[0].output;
    // Seed through the owned snapshot by completing one run before testing the rerun.
    const first = registry.run(instance.id, 'makePrompt');
    expect(registry.get(instance.id).state[output]).toBe('');
    settle?.({
      status: 'ok',
      data: { text: 'Previous result' },
      meta: { engine: 'test', model: 'test', durationMs: 1 },
    });
    await first;

    const rerun = registry.run(instance.id, 'makePrompt');
    const running = registry.get(instance.id);
    expect(running.state[output]).toBe('');
    expect(running.staleOutputs).toBeUndefined();
    settle?.({
      status: 'error',
      error: { code: 'PROVIDER_ERROR', message: 'Model unavailable.' },
    });
    const failed = await rerun;
    expect(failed.instance.state[output]).toBe('');
    expect(failed.instance.staleOutputs).toBeUndefined();
    registry.close();
  });

  it('keeps stale output in the service runtime and lets the newest trigger win', async () => {
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
      instance: {
        state: { source: '   ', result: 'SECOND' },
        staleOutputs: ['result'],
      },
    });
    expect(await registry.run(instance.id, 'translate')).toMatchObject({
      reason: 'missing_required_input',
      instance: { state: { result: 'SECOND' }, staleOutputs: ['result'] },
    });
    expect(calls).toEqual(['second']);
    registry.close();
  });

  it('owns an exclusive interactive lifecycle and resumes after user input', async () => {
    const definition = compileSkillApp(
      painersRoomSource()
        .replace('useProfileSkill(painter, promptMaker, {', "useProfileSkill(painter, 'make-gpt-image-prompt', {")
        .replace('  skills: promptMakers,\n', '')
        .replace('result: promptResult,', 'result: promptResult,\n  interactive: true,'),
      'painers-room/skillapp.ts',
    );
    definition.operations[0].requiredInputs = ['idea'];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async (_app, _operation, state, _signal, _history, _attachments, interactions) => {
        const submission = await interactions!.userInputHandler({
          id: 'question_1',
          questions: [{
            id: 'layout',
            question: 'Which layout?',
            options: [
              { id: 'studio', label: 'Studio' },
              { id: 'form', label: 'Form' },
            ],
          }],
        });
        const selected = submission?.answers[0];
        const answer = selected && 'optionId' in selected ? selected.optionId : 'unknown';
        return {
          status: 'ok',
          data: { text: `${state.idea}:${answer}` },
          meta: { engine: 'test', model: 'test', durationMs: 1 },
        };
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    await registry.update(instance.id, { idea: 'builder' });
    const started = await registry.run(instance.id, 'makePrompt');
    expect(started).toMatchObject({
      status: 'running',
      instance: {
        execution: {
          operation: 'makePrompt',
          phase: 'waiting_for_input',
          cancellable: true,
          userInput: { id: 'question_1' },
        },
      },
    });
    expect(() => registry.updateAttachments(instance.id, 'references', [])).toThrow(/still active/);
    const executionId = started.instance.execution!.id;
    registry.answerUserInput(instance.id, executionId, {
      answers: [{ questionId: 'layout', optionId: 'studio' }],
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(registry.get(instance.id)).toMatchObject({
      state: { result: 'builder:studio' },
      execution: {
        id: executionId,
        phase: 'completed',
        cancellable: false,
        result: { status: 'ok' },
      },
    });
    registry.close();
  });

  it('reports an already committed App install even if the Agent fails afterward', async () => {
    const definition = compileSkillApp(
      painersRoomSource()
        .replace('useProfileSkill(painter, promptMaker, {', "useProfileSkill(painter, 'make-gpt-image-prompt', {")
        .replace('  skills: promptMakers,\n', '')
        .replace('result: promptResult,', 'result: promptResult,\n  interactive: true,'),
      'painers-room/skillapp.ts',
    );
    definition.operations[0].requiredInputs = ['idea'];
    const runtime: SkillAppInstanceRuntime = {
      getApp: () => definition,
      runSkillAppOperation: async (_app, _operation, _state, _signal, _history, _attachments, interactions) => {
        interactions!.effectHandler?.({
          kind: 'app_installed',
          appName: 'writing-studio',
          title: 'Writing Studio',
          action: 'created',
          files: ['skillapp.ts'],
        });
        throw new Error('Provider disconnected after installation');
      },
    };
    const registry = new SkillAppInstanceRegistry(runtime);
    const instance = registry.create('painers-room');
    await registry.update(instance.id, { idea: 'Make a writing App' });
    expect((await registry.run(instance.id, 'makePrompt')).status).toBe('running');

    await vi.waitFor(() => {
      expect(registry.get(instance.id).execution?.phase).toBe('completed');
    });
    expect(registry.get(instance.id)).toMatchObject({
      state: { result: expect.stringContaining("Created SkillApp 'Writing Studio'") },
      execution: {
        phase: 'completed',
        committedEffects: [{ appName: 'writing-studio', action: 'created' }],
        result: {
          status: 'ok',
          effects: [{ appName: 'writing-studio', action: 'created' }],
        },
      },
    });
    registry.close();
  });
});

function translatorSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), '../../examples/apps/translator/skillapp.ts'),
    'utf-8',
  );
}

function painersRoomSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), '../../examples/apps/painers-room/skillapp.ts'),
    'utf-8',
  );
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-skillapp-'));
  tempDirectories.push(directory);
  return directory;
}
