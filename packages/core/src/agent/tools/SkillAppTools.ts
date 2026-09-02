import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { JSONValue } from '@priest-ai/core';
import type { AppStore } from '../../app/AppStore';
import type { SkillAppInstalledEffect } from '../../app/SkillAppSchema';
import { MarifoldError } from '../../errors/MarifoldError';
import type { MarifoldSkill } from '../../skill/SkillSchema';
import {
  type AgentTool,
  requireStringInput,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskAssessment,
} from '../ToolRegistry';

const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILES = 32;
const MAX_TOTAL_BYTES = 512 * 1024;

const V1_TEMPLATE = `import {
  App, Button, Column, Download, Markdown, State, Textarea, TextResult,
  defineSkillApp, registerModel, registerSkill, useSkill,
} from '@marifold/core';

const input = State('');
const result = State('');
const model = registerModel('provider/model', { think: false });
const skill = registerSkill('skill-name', { result: TextResult({ trim: true }) });
const run = useSkill(model, skill, {
  parameters: { request: input },
  output: result,
  memory: false,
  history: false,
  profileContext: false,
});

export default defineSkillApp({
  app: { name: 'app-name', title: 'App title', version: '1.0.0', description: 'Focused purpose.' },
  ui: App([Column([
    Textarea('Input', input),
    Button('Run', { trigger: run, emphasis: 'primary' }),
    Markdown('Result', result),
    Download('Download result', result, { filename: 'result.md', mediaType: 'text/markdown;charset=utf-8' }),
  ])]),
});`;

const V2_TEMPLATE = `import {
  App, Button, Column, State, Textarea, TextResult,
  defineSkillApp, registerProfile, useProfileSkill,
} from '@marifold/core';

const input = State('');
const result = State('');
const profile = registerProfile('profile-name', { memory: false, history: false });
const run = useProfileSkill(profile, 'skill-name', {
  input,
  output: result,
  result: TextResult({ trim: true }),
});

export default defineSkillApp({
  app: { name: 'app-name', title: 'App title', version: '1.0.0', description: 'Focused purpose.' },
  ui: App([Column([
    Textarea('Input', input),
    Button('Run', { trigger: run, emphasis: 'primary' }),
    Textarea('Result', result, { editable: false, copyable: true }),
  ])]),
});`;

interface AppSummary {
  name: string;
  title: string;
  version?: string;
  description?: string;
}

interface ProfileSummary {
  name: string;
  displayName?: string;
}

export interface SkillAppContextToolOptions {
  activeProfile: string;
  appsDir: string;
  listApps: () => AppSummary[];
  listProfiles: () => ProfileSummary[];
  listSkills: (profile: string) => MarifoldSkill[];
}

/** Version-matched authoring context for the protected SkillApp builder. */
export class SkillAppContextTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'inspect_skill_apps',
    description: [
      'Inspect the current Marifold SkillApp authoring environment.',
      'Returns the active profile, existing Apps, available profiles and their effective Skills, and the supported static component contract.',
      'When to use: before designing or generating a SkillApp.',
      'When NOT to use: ordinary Skill execution or unrelated project inspection. It never changes files.',
    ].join(' '),
    parameters: { type: 'object', properties: {} },
  };

  constructor(private readonly options: SkillAppContextToolOptions) {}

  summarizeCall(): string {
    return 'inspect SkillApp components, profiles, Skills, and Apps';
  }

  async execute(): Promise<ToolExecutionResult> {
    const profiles = this.options.listProfiles().map(profile => ({
      name: profile.name,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      skills: this.options.listSkills(profile.name).map(skill => ({
        name: skill.name,
        description: skill.description,
        mode: skill.mode ?? 'profile-default',
        variables: skill.variables.map(variable => ({
          name: variable.name,
          required: variable.required,
          ...(variable.description ? { description: variable.description } : {}),
          ...(variable.default !== undefined ? { default: variable.default } : {}),
        })),
      })),
    }));
    return {
      content: JSON.stringify({
        activeProfile: this.options.activeProfile,
        appsDirectory: this.options.appsDir,
        apps: this.options.listApps(),
        profiles,
        contract: {
          schemas: ['marifold.skillapp.v1', 'marifold.skillapp.v2'],
          declarations: [
            'State(initialText)',
            'AttachmentState()',
            "registerModel('provider/model', { think? })",
            "registerProfile('profile-name', { model?, think?, memory?, history? })",
            "registerSkill('skill-name', { result: TextResult({ trim? }) })",
            'TextResult({ trim? })',
          ],
          layout: ['App', 'Row', 'Column', 'Spacer'],
          form: ['Textarea', 'Select'],
          resources: ['Attachments'],
          outputs: [
            'Markdown(label, state, { showLabel?, grow?, copyable?, sourceToggle?, placeholder? })',
            'Download(label, state, { filename, mediaType?, description?, showLabel?, grow? })',
          ],
          actions: ['Button'],
          operations: [
            'useSkill(model, skill, { parameters, output, memory: false, history: false, profileContext: false })',
            'useProfileSkill(profile, skillNameOrState, { skills?, input?, attachments?, stripSkillName?, parameters?, output, result, interactive? })',
            'trigger(operation, { onChange, debounce?, concurrency?: "latest" })',
          ],
          interactive: 'Set useProfileSkill(..., { interactive: true }) for an Agent Skill that may ask questions or request approval.',
          bundle: {
            common: [
              'skillapp.ts is required; app.name and the bundle name must be the same kebab-case value',
              'replace the example app, profile, model, Skill, labels, parameter names, and filenames with the requested design',
            ],
            v1: [
              'use registerModel + registerSkill + useSkill',
              'include skills/<skill-name>/SKILL.md whose frontmatter name matches registerSkill',
              'map every required SKILL.md variable to a State in useSkill.parameters',
            ],
            v2: [
              'use registerProfile + useProfileSkill and one Skill from that profile effective catalog',
              'do not copy the profile Skill into the App bundle',
            ],
          },
          templates: {
            v1: V1_TEMPLATE,
            v1Skill: '---\\nname: skill-name\\nvariables:\\n  - name: request\\n    required: true\\n---\\nPerform the focused task and return only the requested result.\\n\\n{{request}}',
            v2: V2_TEMPLATE,
          },
          constraints: [
            'skillapp.ts is statically compiled and never executed',
            'no functions, callbacks, conditions, loops, arbitrary imports, HTML, CSS, network calls, or direct filesystem writes',
            'one interactive operation runs exclusively per App instance',
            'interactive operations cannot use automatic triggers',
            'Markdown and Download may bind the same text output State; Download creates the file in the renderer without filesystem access',
            'each Download is one text file with a static filename; multiple components make multiple static downloads, while binary files, per-run filenames, and dynamic file collections are unsupported',
            'v1 uses an app-local chat Skill and registered model; v2 registers an existing profile and its effective Skill',
            'inspect_skill_apps is authoritative; do not probe App directories or arbitrary host paths for examples',
          ],
        },
      }, null, 2),
      summary: `inspected ${profiles.length} profiles and ${this.options.listApps().length} Apps`,
    };
  }
}

export interface SkillAppManagementToolOptions {
  appsDir: string;
  createStore: (appsDir: string) => AppStore;
  onInstalled?: (effect: SkillAppInstalledEffect) => void;
}

interface BundleTextFile {
  path: string;
  content: string;
}

/** Confined, validated, atomic mutation boundary for generated App bundles. */
export class SkillAppManagementTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'manage_skill_app',
    description: [
      'Create or update exactly one global Marifold SkillApp bundle from generated text files.',
      'The complete staged bundle is statically compiled and validated before an atomic install.',
      'When to use: after inspecting the SkillApp environment and resolving essential design decisions.',
      'When NOT to use: arbitrary file writes, unvalidated application code, or implicit replacement after a name collision.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update'] },
        name: { type: 'string', description: 'Kebab-case App and bundle name.' },
        files: {
          type: 'array',
          description: 'Complete generated text files relative to the App bundle, including skillapp.ts.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['action', 'name', 'files'],
    },
  };
  private failedAttempts = 0;
  private lastFailure?: string;

  constructor(private readonly options: SkillAppManagementToolOptions) {}

  summarizeCall(input: Record<string, JSONValue>): string {
    const action = input.action === 'update' ? 'update' : 'create';
    const name = typeof input.name === 'string' ? input.name : '<missing App>';
    return `${action} SkillApp ${name}`;
  }

  assessRisk(input: Record<string, JSONValue>): ToolRiskAssessment {
    const name = typeof input.name === 'string' && SAFE_APP_NAME.test(input.name)
      ? input.name
      : '<invalid-app>';
    if (this.failedAttempts >= 3) {
      return {
        blocked: true,
        escalate: false,
        persistable: false,
        reason: `three SkillApp validation attempts failed; stop and report the last error${this.lastFailure ? `: ${this.lastFailure}` : ''}`,
        targetPath: path.join(this.options.appsDir, name),
      };
    }
    return {
      escalate: true,
      persistable: false,
      reason: 'installing a persistent Marifold App bundle',
      targetPath: path.join(this.options.appsDir, name),
    };
  }

  async execute(input: Record<string, JSONValue>, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    let stageRoot: string | undefined;
    try {
      const action = requireStringInput(input, 'action', 'manage_skill_app');
      if (action !== 'create' && action !== 'update') {
        throw MarifoldError.agentToolInvalid(`Unsupported SkillApp action '${action}'.`, 'manage_skill_app');
      }
      const name = requireStringInput(input, 'name', 'manage_skill_app');
      if (!SAFE_APP_NAME.test(name)) {
        throw MarifoldError.appInvalid(`Invalid App name '${name}'. Use kebab-case.`);
      }
      const files = bundleFiles(input.files);
      if (!files.some(file => file.path === 'skillapp.ts')) {
        throw MarifoldError.appInvalid("A generated App bundle must include 'skillapp.ts'.");
      }

      fs.mkdirSync(this.options.appsDir, { recursive: true });
      const target = path.join(this.options.appsDir, name);
      const exists = fs.existsSync(target);
      if (action === 'create' && exists) {
        throw MarifoldError.appInvalid(`App '${name}' already exists. Use update only after the user explicitly requests replacing it.`);
      }
      if (action === 'update' && !exists) {
        throw MarifoldError.appNotFound(name);
      }
      if (exists && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) {
        throw MarifoldError.appInvalid(`App target '${name}' is not a regular bundle directory.`);
      }

      stageRoot = fs.mkdtempSync(path.join(this.options.appsDir, '.skillapp-stage-'));
      const stagedBundle = path.join(stageRoot, name);
      fs.mkdirSync(stagedBundle, { recursive: true });
      for (const file of files) {
        const destination = path.join(stagedBundle, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.content, 'utf8');
      }

      const definition = this.options.createStore(stageRoot).require(name);
      const installedFiles = listRegularFiles(stagedBundle);
      installAtomically(stagedBundle, target, action);
      const effect: SkillAppInstalledEffect = {
        kind: 'app_installed',
        appName: name,
        title: definition.app.title,
        action: action === 'create' ? 'created' : 'updated',
        files: installedFiles,
      };
      this.options.onInstalled?.(effect);
      this.failedAttempts = 0;
      this.lastFailure = undefined;
      return {
        content: `${action === 'create' ? 'Created' : 'Updated'} SkillApp '${definition.app.title}' (${name}) with ${installedFiles.length} validated ${installedFiles.length === 1 ? 'file' : 'files'}. The service does not need a restart.`,
        summary: `${effect.action} SkillApp ${name}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failedAttempts += 1;
      this.lastFailure = message;
      return {
        content: `SkillApp management failed: ${message}${this.failedAttempts >= 3 ? ' No further installation attempts are allowed in this run; report this error to the user.' : ''}`,
        summary: `SkillApp validation failed: ${message.length > 300 ? `${message.slice(0, 297)}...` : message}`,
        isError: true,
      };
    } finally {
      if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

function bundleFiles(value: JSONValue | undefined): BundleTextFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw MarifoldError.agentToolInvalid(`manage_skill_app.files must contain 1-${MAX_FILES} text files.`, 'manage_skill_app');
  }
  const seen = new Set<string>();
  let total = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw MarifoldError.agentToolInvalid(`manage_skill_app.files[${index}] must be an object.`, 'manage_skill_app');
    }
    const file = entry as Record<string, JSONValue>;
    const relative = safeBundlePath(requireStringInput(file, 'path', 'manage_skill_app'));
    if (seen.has(relative)) throw MarifoldError.appInvalid(`Duplicate App file '${relative}'.`);
    seen.add(relative);
    if (typeof file.content !== 'string') {
      throw MarifoldError.agentToolInvalid(`manage_skill_app.files[${index}].content must be text.`, 'manage_skill_app');
    }
    total += Buffer.byteLength(file.content, 'utf8');
    if (total > MAX_TOTAL_BYTES) {
      throw MarifoldError.appInvalid(`Generated App bundle exceeds ${MAX_TOTAL_BYTES / 1024} KiB.`);
    }
    return { path: relative, content: file.content };
  });
}

function safeBundlePath(value: string): string {
  if (value.includes('\0')) throw MarifoldError.appInvalid('App file paths cannot contain null bytes.');
  const portable = value.replace(/\\/g, '/');
  const parts = portable.split('/');
  if (portable.startsWith('/') || /^[a-z]:\//i.test(portable)
    || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw MarifoldError.appInvalid(`Unsafe App file path '${value}'.`);
  }
  return parts.join(path.sep);
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile()) files.push(path.relative(root, source).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function installAtomically(stagedBundle: string, target: string, action: 'create' | 'update'): void {
  if (action === 'create') {
    fs.renameSync(stagedBundle, target);
    return;
  }
  const backup = path.join(path.dirname(target), `.skillapp-backup-${path.basename(target)}-${randomUUID()}`);
  fs.renameSync(target, backup);
  try {
    fs.renameSync(stagedBundle, target);
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch {
    // The validated target is already installed; a stale hidden backup is safer
    // than reporting a false installation failure or disturbing the new bundle.
  }
}
