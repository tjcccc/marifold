import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { MarifoldError } from '../../errors/MarifoldError';
import { isBuiltInSkillName } from '../../skill/BuiltInSkills';
import { readSkillSource, SkillScope, SkillStore } from '../../skill/SkillStore';
import { parseSkill } from '../../skill/SkillValidator';
import { expandHome } from '../../workspace/WorkspacePaths';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

interface BundledTextFile {
  path: string;
  content: string;
}

export interface SkillManagementToolOptions {
  store: SkillStore;
  profile: string;
  globalDir: string;
  profileDir: string;
}

/** Validated mutation boundary used by Marifold's protected management skills. */
export class SkillManagementTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'manage_skill',
    description: [
      'Create, install, update, or remove a user-managed Marifold skill in the active profile or configured global skill directory.',
      'When to use: Marifold skill management after the user invokes a protected management skill or explicitly asks the agent to change a skill.',
      'When NOT to use: running a skill, editing unrelated files, managing protected built-ins, fetching network sources, or changing both scopes at once.',
      'Profile scope is the default user-facing scope; pass the exact intended scope on every call.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'install', 'update', 'remove'],
          description: 'The validated skill mutation to perform.',
        },
        scope: {
          type: 'string',
          enum: ['profile', 'global'],
          description: 'Exact destination scope. Use profile unless the user explicitly requested global.',
        },
        name: {
          type: 'string',
          description: 'Required for create, update, and remove. Must match the SKILL.md name for create/update.',
        },
        source: {
          type: 'string',
          description: 'Local Markdown file or folder containing SKILL.md. Required for install and update.',
        },
        content: {
          type: 'string',
          description: 'Complete SKILL.md text. Required for create.',
        },
        files: {
          type: 'array',
          description: 'Optional bundled text files for create, using safe paths relative to the new skill folder.',
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
      required: ['action', 'scope'],
    },
  };

  constructor(private readonly options: SkillManagementToolOptions) {}

  summarizeCall(input: Record<string, JSONValue>): string {
    const action = typeof input.action === 'string' ? input.action : '<missing action>';
    const scope = typeof input.scope === 'string' ? input.scope : 'profile';
    const target = typeof input.name === 'string'
      ? `$${input.name}`
      : typeof input.source === 'string'
        ? input.source
        : '<missing skill>';
    return `${action} ${scope} skill ${target}`;
  }

  assessRisk(input: Record<string, JSONValue>): ToolRiskAssessment {
    const scope = input.scope === 'global' ? 'global' : 'profile';
    const dir = this.dirForScope(scope);
    const suppliedName = typeof input.name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(input.name)
      ? input.name
      : undefined;
    const target = suppliedName ? path.join(dir, suppliedName) : dir;
    return {
      escalate: true,
      persistable: false,
      reason: `modifying the ${scope} Marifold skill directory`,
      targetPath: target,
    };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const action = requireStringInput(input, 'action', 'manage_skill');
      const scope = skillScope(input.scope);
      switch (action) {
        case 'create':
          return this.create(input, scope);
        case 'install':
          return this.install(input, scope, ctx);
        case 'update':
          return this.update(input, scope, ctx);
        case 'remove':
          return this.remove(input, scope);
        default:
          throw MarifoldError.agentToolInvalid(
            `Tool 'manage_skill' received unsupported action '${action}'.`,
            'manage_skill',
          );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Skill management failed: ${message}`,
        summary: 'skill management failed',
        isError: true,
      };
    }
  }

  private create(input: Record<string, JSONValue>, scope: SkillScope): ToolExecutionResult {
    const name = requireMutableName(input, 'name');
    const content = requireStringInput(input, 'content', 'manage_skill');
    const skill = parseSkill(content);
    if (skill.name !== name) {
      throw MarifoldError.skillInvalid(`Requested name '${name}' does not match SKILL.md name '${skill.name}'.`);
    }
    if (this.exactSkill(name, scope)) {
      throw MarifoldError.skillInvalid(
        `Skill '${name}' already exists in ${scope} scope. Choose another name or update it separately.`,
      );
    }
    const files = bundledTextFiles(input.files);
    const installed = this.options.store.installFromText(content, scope);
    const skillDir = path.dirname(installed.source!);
    try {
      for (const file of files) {
        const target = path.join(skillDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      this.verify(name, scope);
    } catch (error) {
      this.options.store.remove(name, scope);
      throw error;
    }
    return {
      content: `Created $${name} in ${this.scopeLabel(scope)} at ${skillDir}. Invoke it with $${name}.`,
      summary: `created ${scope} skill $${name}`,
    };
  }

  private install(
    input: Record<string, JSONValue>,
    scope: SkillScope,
    ctx: ToolExecutionContext,
  ): ToolExecutionResult {
    const source = localSource(input, ctx);
    const preview = readSkillSource(source);
    if (isBuiltInSkillName(preview.skill.name)) {
      throw protectedBuiltIn(preview.skill.name);
    }
    const existed = Boolean(this.exactSkill(preview.skill.name, scope));
    const installed = this.options.store.installFromFile(source, scope);
    this.verify(installed.name, scope);
    const verb = existed ? 'Updated' : 'Installed';
    return {
      content: `${verb} $${installed.name} in ${this.scopeLabel(scope)} at ${path.dirname(installed.source!)}.`,
      summary: `${verb.toLowerCase()} ${scope} skill $${installed.name}`,
    };
  }

  private update(
    input: Record<string, JSONValue>,
    scope: SkillScope,
    ctx: ToolExecutionContext,
  ): ToolExecutionResult {
    const name = requireMutableName(input, 'name');
    if (!this.exactSkill(name, scope)) {
      throw MarifoldError.skillInvalid(`Skill '${name}' does not exist in ${scope} scope.`);
    }
    const source = localSource(input, ctx);
    const preview = readSkillSource(source);
    if (preview.skill.name !== name) {
      throw MarifoldError.skillInvalid(
        `Update source name '${preview.skill.name}' does not match requested skill '${name}'.`,
      );
    }
    const installed = this.options.store.installFromFile(source, scope);
    this.verify(name, scope);
    return {
      content: `Updated $${name} in ${this.scopeLabel(scope)} at ${path.dirname(installed.source!)}.`,
      summary: `updated ${scope} skill $${name}`,
    };
  }

  private remove(input: Record<string, JSONValue>, scope: SkillScope): ToolExecutionResult {
    const name = requireMutableName(input, 'name');
    const existing = this.exactSkill(name, scope);
    if (!existing) {
      throw MarifoldError.skillInvalid(`Skill '${name}' does not exist in ${scope} scope.`);
    }
    const removedDir = path.dirname(existing.source!);
    this.options.store.remove(name, scope);
    const effective = this.options.store.get(name);
    const fallback = effective
      ? ` The ${effective.scope} copy at ${path.dirname(effective.source!)} is now effective.`
      : ' No user-managed copy remains effective.';
    return {
      content: `Removed $${name} from ${this.scopeLabel(scope)} at ${removedDir}.${fallback}`,
      summary: `removed ${scope} skill $${name}`,
    };
  }

  private exactSkill(name: string, scope: SkillScope) {
    return this.options.store.list(scope).find(skill => skill.name === name);
  }

  private verify(name: string, scope: SkillScope): void {
    if (!this.exactSkill(name, scope)) {
      throw MarifoldError.skillInvalid(`Could not verify '${name}' after writing ${scope} scope.`);
    }
  }

  private dirForScope(scope: SkillScope): string {
    return scope === 'global' ? this.options.globalDir : this.options.profileDir;
  }

  private scopeLabel(scope: SkillScope): string {
    return scope === 'global' ? 'global scope' : `profile '${this.options.profile}'`;
  }
}

function skillScope(value: JSONValue | undefined): SkillScope {
  if (value === 'profile' || value === 'global') return value;
  throw MarifoldError.agentToolInvalid(
    "Tool 'manage_skill' requires scope 'profile' or 'global'.",
    'manage_skill',
  );
}

function requireMutableName(input: Record<string, JSONValue>, key: string): string {
  const name = requireStringInput(input, key, 'manage_skill');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw MarifoldError.skillInvalid(
      `Invalid skill name '${name}'. Use lowercase letters, numbers, underscores, or hyphens (starting alphanumeric).`,
    );
  }
  if (isBuiltInSkillName(name)) throw protectedBuiltIn(name);
  return name;
}

function protectedBuiltIn(name: string): MarifoldError {
  return MarifoldError.skillInvalid(
    `Skill '${name}' is a protected Marifold built-in and cannot be installed, updated, or removed.`,
  );
}

function localSource(input: Record<string, JSONValue>, ctx: ToolExecutionContext): string {
  const source = expandHome(requireStringInput(input, 'source', 'manage_skill'));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw MarifoldError.skillInvalid('Skill sources must be local files or folders; network URLs are not supported.');
  }
  return path.resolve(ctx.cwd, source);
}

function bundledTextFiles(value: JSONValue | undefined): BundledTextFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw MarifoldError.agentToolInvalid("Tool 'manage_skill' expects 'files' to be an array.", 'manage_skill');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw MarifoldError.agentToolInvalid(`Tool 'manage_skill' expects files[${index}] to be an object.`, 'manage_skill');
    }
    const file = entry as Record<string, JSONValue>;
    if (typeof file.content !== 'string') {
      throw MarifoldError.agentToolInvalid(
        `Tool 'manage_skill' requires files[${index}].content to be a string.`,
        'manage_skill',
      );
    }
    const relative = safeBundledPath(requireStringInput(file, 'path', 'manage_skill'));
    if (seen.has(relative)) {
      throw MarifoldError.skillInvalid(`Duplicate bundled file path '${relative}'.`);
    }
    seen.add(relative);
    return {
      path: relative,
      content: file.content,
    };
  });
}

function safeBundledPath(value: string): string {
  if (value.includes('\0')) {
    throw MarifoldError.skillInvalid('Bundled file paths cannot contain null bytes.');
  }
  const portable = value.replace(/\\/g, '/');
  const parts = portable.split('/');
  if (
    portable.startsWith('/')
    || /^[a-z]:\//i.test(portable)
    || parts.some(part => part === '' || part === '.' || part === '..')
  ) {
    throw MarifoldError.skillInvalid(`Unsafe bundled file path '${value}'.`);
  }
  if (portable === 'SKILL.md') {
    throw MarifoldError.skillInvalid("Bundled files cannot replace the skill's SKILL.md.");
  }
  return parts.join(path.sep);
}
