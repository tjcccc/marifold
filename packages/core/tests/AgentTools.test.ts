import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AskUserTool } from '../src/agent/tools/AskUserTool';
import { DelegateTool } from '../src/agent/tools/DelegateTool';
import { InspectAttachmentTool } from '../src/agent/tools/InspectAttachmentTool';
import { PythonPackageTool } from '../src/agent/tools/PythonPackageTool';
import { ReadAttachmentTool } from '../src/agent/tools/ReadAttachmentTool';
import { ReadFileTool } from '../src/agent/tools/ReadFileTool';
import { SearchAttachmentTool } from '../src/agent/tools/SearchAttachmentTool';
import { ShellExecTool } from '../src/agent/tools/ShellExecTool';
import { WebSearchTool } from '../src/agent/tools/WebSearchTool';
import { isInsideWorkspace, WriteFileTool } from '../src/agent/tools/WriteFileTool';
import { SkillManagementTool } from '../src/agent/tools/SkillManagementTool';
import { SkillAppContextTool, SkillAppManagementTool } from '../src/agent/tools/SkillAppTools';
import { AppStore } from '../src/app/AppStore';
import { createRunWorkspace } from '../src/agent/RunWorkspace';
import { capToolOutput, ToolExecutionContext, ToolRegistry } from '../src/agent/ToolRegistry';
import { SkillStore } from '../src/skill/SkillStore';
import { getBuiltInSkill } from '../src/skill/BuiltInSkills';
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

  it('gives every built-in tool explicit positive and negative affordances', () => {
    const tools = [
      new AskUserTool(),
      new InspectAttachmentTool(),
      new ReadAttachmentTool(),
      new SearchAttachmentTool(),
      new ReadFileTool(),
      new WriteFileTool(),
      new ShellExecTool(),
      new PythonPackageTool(),
      new WebSearchTool({ search: async () => [] }),
      new DelegateTool({
        ask: async () => ({ ok: true, text: '' }),
        listProfileNames: () => [],
      }),
      skillManagementTool(),
      new SkillAppContextTool({
        activeProfile: 'writer',
        appsDir: '/tmp/apps',
        listApps: () => [],
        listProfiles: () => [],
        listSkills: () => [],
      }),
      new SkillAppManagementTool({
        appsDir: '/tmp/apps',
        createStore: appsDir => new AppStore(appsDir),
      }),
    ];

    for (const tool of tools) {
      expect(tool.definition.description, tool.definition.name).toContain('When to use:');
      expect(tool.definition.description, tool.definition.name).toContain('When NOT to use:');
    }
  });
});

describe('SkillAppContextTool', () => {
  it('reports the exact Markdown and Download authoring contract', async () => {
    const tool = new SkillAppContextTool({
      activeProfile: 'writer',
      appsDir: '/tmp/apps',
      listApps: () => [],
      listProfiles: () => [],
      listSkills: () => [],
    });
    const result = JSON.parse((await tool.execute()).content) as {
      contract: {
        outputs: string[];
        constraints: string[];
        templates: { v1: string; v1Skill: string; v2: string };
        bundle: { v1: string[]; v2: string[] };
      };
    };

    expect(result.contract.outputs).toEqual([
      'Markdown(label, state, { showLabel?, grow?, copyable?, sourceToggle?, placeholder? })',
      'Download(label, state, { filename, mediaType?, description?, showLabel?, grow? })',
    ]);
    expect(result.contract.constraints).toContain(
      'Markdown and Download may bind the same text output State; Download creates the file in the renderer without filesystem access',
    );
    expect(result.contract.constraints).toContain(
      'each Download is one text file with a static filename; multiple components make multiple static downloads, while binary files, per-run filenames, and dynamic file collections are unsupported',
    );
    expect(result.contract.templates.v1).toContain("registerModel('provider/model'");
    expect(result.contract.templates.v1).toContain("Download('Download result', result");
    expect(result.contract.templates.v1Skill).toContain('{{request}}');
    expect(result.contract.templates.v2).toContain("registerProfile('profile-name'");
    expect(result.contract.bundle.v1).toContain('include skills/<skill-name>/SKILL.md whose frontmatter name matches registerSkill');
    expect(result.contract.bundle.v2).toContain('do not copy the profile Skill into the App bundle');
  });
});

describe('SkillAppManagementTool', () => {
  it('statically validates and atomically creates an interactive App bundle', async () => {
    const root = tempDir();
    const appsDir = path.join(root, 'apps');
    const effects: Array<{ appName: string; action: string }> = [];
    const tool = new SkillAppManagementTool({
      appsDir,
      createStore: directory => new AppStore(directory, {
        resolveProfileSkill: (_profile, skillName) => getBuiltInSkill(skillName),
      }),
      onInstalled: effect => effects.push(effect),
    });
    const source = `
      import { App, Button, Row, State, Textarea, TextResult, defineSkillApp, registerProfile, useProfileSkill } from '@marifold/core';
      const idea = State('');
      const result = State('');
      const assistant = registerProfile('default', { memory: false, history: false });
      const build = useProfileSkill(assistant, 'skillapp-builder', {
        input: idea,
        output: result,
        result: TextResult({ trim: true }),
        interactive: true,
      });
      export default defineSkillApp({
        app: { name: 'app-studio', title: 'App Studio' },
        ui: App([
          Row([Textarea('Idea', idea)]),
          Row([Button('Build', { trigger: build })]),
          Row([Textarea('Result', result, { editable: false, copyable: true })]),
        ]),
      });
    `;

    const created = await tool.execute({
      action: 'create',
      name: 'app-studio',
      files: [{ path: 'skillapp.ts', content: source }],
    }, context(root));

    expect(created.isError, created.content).toBeFalsy();
    expect(created.content).toContain('does not need a restart');
    expect(fs.readFileSync(path.join(appsDir, 'app-studio', 'skillapp.ts'), 'utf8')).toBe(source);
    expect(effects).toEqual([expect.objectContaining({ appName: 'app-studio', action: 'created' })]);
    expect(fs.readdirSync(appsDir).filter(name => name.startsWith('.skillapp-'))).toEqual([]);

    const collision = await tool.execute({
      action: 'create',
      name: 'app-studio',
      files: [{ path: 'skillapp.ts', content: source }],
    }, context(root));
    expect(collision.isError).toBe(true);
    expect(collision.content).toContain('already exists');

    fs.writeFileSync(path.join(appsDir, 'app-studio', 'obsolete.txt'), 'remove me');
    const updatedSource = source.replace("title: 'App Studio'", "title: 'App Studio 2'");
    const updated = await tool.execute({
      action: 'update',
      name: 'app-studio',
      files: [{ path: 'skillapp.ts', content: updatedSource }],
    }, context(root));
    expect(updated.isError, updated.content).toBeFalsy();
    expect(fs.readFileSync(path.join(appsDir, 'app-studio', 'skillapp.ts'), 'utf8')).toBe(updatedSource);
    expect(fs.existsSync(path.join(appsDir, 'app-studio', 'obsolete.txt'))).toBe(false);
    expect(effects.at(-1)).toMatchObject({ appName: 'app-studio', action: 'updated' });
    expect(fs.readdirSync(appsDir).filter(name => name.startsWith('.skillapp-'))).toEqual([]);
  });

  it('blocks a runaway builder after three invalid installation attempts', async () => {
    const root = tempDir();
    const appsDir = path.join(root, 'apps');
    const tool = new SkillAppManagementTool({
      appsDir,
      createStore: directory => new AppStore(directory),
    });
    const invalid = {
      action: 'create',
      name: 'broken-app',
      files: [{ path: 'skillapp.ts', content: 'not a SkillApp' }],
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await tool.execute(invalid, context(root));
      expect(result.isError).toBe(true);
      expect(result.summary).toContain('SkillApp validation failed:');
    }
    expect(tool.assessRisk(invalid, context(root))).toMatchObject({
      blocked: true,
      escalate: false,
      persistable: false,
      reason: expect.stringContaining('three SkillApp validation attempts failed'),
    });
  });
});

describe('SkillManagementTool', () => {
  it('creates a profile skill with bundled files and refuses collisions', async () => {
    const root = tempDir();
    const globalDir = path.join(root, 'skills');
    const profileDir = path.join(root, 'profiles', 'writer', 'skills');
    const tool = skillManagementTool({ globalDir, profileDir });
    const content = skillText('draft-helper', 'Draft concise text.');

    const created = await tool.execute({
      action: 'create',
      scope: 'profile',
      name: 'draft-helper',
      content,
      files: [{ path: 'references/style.txt', content: 'Concise.' }],
    }, context(root));

    expect(created.isError, created.content).toBeFalsy();
    expect(created.content).toContain("profile 'writer'");
    expect(fs.readFileSync(path.join(profileDir, 'draft-helper', 'SKILL.md'), 'utf-8')).toBe(content);
    expect(fs.readFileSync(path.join(profileDir, 'draft-helper', 'references', 'style.txt'), 'utf-8')).toBe('Concise.');

    const collision = await tool.execute({
      action: 'create',
      scope: 'profile',
      name: 'draft-helper',
      content,
    }, context(root));
    expect(collision.isError).toBe(true);
    expect(collision.content).toContain('already exists');
  });

  it('installs and updates only the exact requested scope', async () => {
    const root = tempDir();
    const globalDir = path.join(root, 'skills');
    const profileDir = path.join(root, 'profiles', 'writer', 'skills');
    const tool = skillManagementTool({ globalDir, profileDir });
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), skillText('translate', 'Global v1.'));

    const installed = await tool.execute({
      action: 'install',
      scope: 'global',
      source: sourceDir,
    }, context(root));
    expect(installed.isError, installed.content).toBeFalsy();
    expect(fs.readFileSync(path.join(globalDir, 'translate', 'SKILL.md'), 'utf-8')).toContain('Global v1.');
    expect(fs.existsSync(path.join(profileDir, 'translate', 'SKILL.md'))).toBe(false);

    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), skillText('translate', 'Global v2.'));
    const updated = await tool.execute({
      action: 'update',
      scope: 'global',
      name: 'translate',
      source: sourceDir,
    }, context(root));
    expect(updated.isError, updated.content).toBeFalsy();
    expect(fs.readFileSync(path.join(globalDir, 'translate', 'SKILL.md'), 'utf-8')).toContain('Global v2.');
  });

  it('reports shadow fallback after removing a profile skill', async () => {
    const root = tempDir();
    const globalDir = path.join(root, 'skills');
    const profileDir = path.join(root, 'profiles', 'writer', 'skills');
    const store = new SkillStore({ globalDir, profileDir });
    store.installFromText(skillText('translate', 'Global.'), 'global');
    store.installFromText(skillText('translate', 'Profile.'), 'profile');
    const tool = skillManagementTool({ globalDir, profileDir, store });

    const removed = await tool.execute({
      action: 'remove',
      scope: 'profile',
      name: 'translate',
    }, context(root));

    expect(removed.isError, removed.content).toBeFalsy();
    expect(removed.content).toContain('global copy');
    expect(store.get('translate')?.scope).toBe('global');
  });

  it('protects built-ins, rejects network sources, and escalates every mutation', async () => {
    const root = tempDir();
    const globalDir = path.join(root, 'skills');
    const profileDir = path.join(root, 'profiles', 'writer', 'skills');
    const tool = skillManagementTool({ globalDir, profileDir });

    const protectedResult = await tool.execute({
      action: 'remove',
      scope: 'global',
      name: 'skill-installer',
    }, context(root));
    expect(protectedResult.isError).toBe(true);
    expect(protectedResult.content).toContain('protected Marifold built-in');

    const network = await tool.execute({
      action: 'install',
      scope: 'profile',
      source: 'https://example.com/SKILL.md',
    }, context(root));
    expect(network.isError).toBe(true);
    expect(network.content).toContain('local files or folders');

    expect(tool.assessRisk({ action: 'remove', scope: 'profile', name: 'translate' }, context(root))).toMatchObject({
      escalate: true,
      persistable: false,
      targetPath: path.join(profileDir, 'translate'),
    });
  });
});

function skillManagementTool(options?: {
  globalDir?: string;
  profileDir?: string;
  store?: SkillStore;
}): SkillManagementTool {
  const root = tempDir();
  const globalDir = options?.globalDir ?? path.join(root, 'skills');
  const profileDir = options?.profileDir ?? path.join(root, 'profiles', 'writer', 'skills');
  return new SkillManagementTool({
    store: options?.store ?? new SkillStore({ globalDir, profileDir }),
    profile: 'writer',
    globalDir,
    profileDir,
  });
}

function skillText(name: string, prompt: string): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n\n${prompt}\n`;
}

describe('InspectAttachmentTool', () => {
  it('opens staged images by opaque attachment ID', async () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'tool_attachment_image',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      images: [{ data: Buffer.from('image-bytes').toString('base64'), mediaType: 'image/png' }],
    });
    const result = await new InspectAttachmentTool().execute(
      { attachment_id: 'attachment-1' },
      { cwd, outputLimit: 100000, workspace },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('now visible as image input');
    expect(result.images).toEqual([
      expect.objectContaining({ path: workspace.attachments[0].path, mediaType: 'image/png' }),
    ]);
    expect(new InspectAttachmentTool().assessRisk()).toEqual({ escalate: false, trusted: true });
  });

  it('returns a bounded document preview with the authoritative run path and rejects unknown IDs', async () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'tool_attachment_document',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      files: [{
        name: 'budget.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: Buffer.from('binary-workbook').toString('base64'),
        inspectionText: `Sheet: Budget\nA1: Revenue\n${'row data\n'.repeat(2_000)}`,
      }],
    });
    const tool = new InspectAttachmentTool();
    const ctx: ToolExecutionContext = { cwd, outputLimit: 100000, workspace };

    const inspected = await tool.execute({ attachment_id: 'attachment-1' }, ctx);
    expect(inspected.content).toContain('Sheet');
    expect(inspected.content).toContain(`Read-only run path: ${workspace.attachments[0].path}`);
    expect(inspected.content).toContain('preview bounded');
    expect(inspected.content.length).toBeLessThan(10_000);

    const missing = await tool.execute({ attachment_id: '../../etc/passwd' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('Available attachment IDs: attachment-1');
  });

  it('reads bounded ranges and searches readable attachment views', async () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'tool_attachment_resource',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      files: [{
        name: 'report.pdf',
        mediaType: 'application/pdf',
        data: Buffer.from('pdf').toString('base64'),
        inspectionText: 'Chapter 1\nAlpha\nChapter 2\nNeedle result\nChapter 3',
      }],
    });
    const ctx: ToolExecutionContext = { cwd, outputLimit: 100000, workspace };

    const read = await new ReadAttachmentTool().execute(
      { attachment_id: 'attachment-1', start: 10, max_chars: 12 },
      ctx,
    );
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('Characters 10-22');
    expect(read.content).toContain('[more available; continue with start=22]');

    const search = await new SearchAttachmentTool().execute(
      { attachment_id: 'attachment-1', query: 'needle' },
      ctx,
    );
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('Line 4: Needle result');
    expect(new ReadAttachmentTool().assessRisk()).toEqual({ escalate: false, trusted: true });
    expect(new SearchAttachmentTool().assessRisk()).toEqual({ escalate: false, trusted: true });
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

  it('enforces exact-file SkillApp grants without exposing sibling files', async () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    const sharedDir = path.join(home, 'shared');
    const granted = path.join(sharedDir, 'vars.toml');
    const sibling = path.join(sharedDir, 'private.toml');
    fs.mkdirSync(cwd);
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(granted, 'look = "cinematic"');
    fs.writeFileSync(sibling, 'secret = true');
    const workspace = createRunWorkspace({
      id: 'tool_exact_read',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
      readOnlyFiles: [granted],
    });
    const ctx: ToolExecutionContext = { cwd, outputLimit: 100000, workspace };
    const tool = new ReadFileTool({ strictWorkspace: true });

    expect(tool.assessRisk({ path: granted }, ctx)).toEqual({ escalate: false, trusted: true });
    expect(tool.assessRisk({ path: sibling }, ctx)).toMatchObject({ blocked: true });
    expect((await tool.execute({ path: granted }, ctx)).content).toContain('cinematic');
    const blocked = await tool.execute({ path: sibling }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('declared read permissions');
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

  it('resolves scoped ~/ file paths against the user home, not the disposable run home', async () => {
    const home = tempDir();
    const cwd = path.join(home, 'repo');
    fs.mkdirSync(cwd);
    const workspace = createRunWorkspace({
      id: 'tool_home_path',
      cwd,
      runsDir: path.join(home, '.marifold', 'runs'),
      userHome: home,
    });
    const ctx: ToolExecutionContext = { cwd, outputLimit: 100000, workspace };
    const tool = new WriteFileTool();
    const target = path.join(fs.realpathSync(home), 'tempfiles', 'test.md');

    expect(tool.assessRisk({ path: '~/tempfiles/test.md', content: '# test\ntest\n' }, ctx)).toMatchObject({
      escalate: true,
      targetPath: target,
    });
    const result = await tool.execute({ path: '~/tempfiles/test.md', content: '# test\ntest\n' }, ctx);

    expect(result.isError, result.content).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('# test\ntest\n');
    expect(fs.existsSync(path.join(workspace.homeDir, 'tempfiles', 'test.md'))).toBe(false);
  });

  it('isInsideWorkspace handles traversal and absolute paths', () => {
    expect(isInsideWorkspace('/tmp/ws/a/b.txt', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/ws', '/tmp/ws')).toBe(true);
    expect(isInsideWorkspace('/tmp/other/b.txt', '/tmp/ws')).toBe(false);
    expect(isInsideWorkspace('/tmp/ws/../escape.txt', '/tmp/ws')).toBe(false);
  });
});

describe('ShellExecTool', () => {
  it.skipIf(process.platform !== 'darwin')('runs commands in cwd with user-home shell semantics and captures output', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    const ctx = scopedContext(dir);
    const result = await new ShellExecTool().execute({ command: 'ls; printf "\\nhome=%s\\ntilde=%s" "$HOME" ~' }, ctx);
    expect(result.content).toContain('c.txt');
    expect(result.content).toContain(`home=${ctx.workspace!.userHome}`);
    expect(result.content).toContain(`tilde=${ctx.workspace!.userHome}`);
    expect(result.content).not.toContain(`home=${ctx.workspace!.homeDir}`);
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

  it.skipIf(process.platform !== 'darwin')('keeps ungranted user-home files private with user-home shell semantics', async () => {
    const home = tempDir();
    const dir = path.join(home, 'workspace');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(home, 'private.txt'), 'must-stay-private');
    const result = await new ShellExecTool().execute(
      { command: 'cat ~/private.txt' },
      scopedContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('must-stay-private');
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
