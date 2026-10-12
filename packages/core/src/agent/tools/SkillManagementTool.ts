import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import { MarifoldError } from '../../errors/MarifoldError';
import { isBuiltInSkillName } from '../../skill/BuiltInSkills';
import { stageSkillBundle } from '../../skill/SkillBundle';
import { readSkillSource, type SkillScope, SkillStore } from '../../skill/SkillStore';
import { parseSkill } from '../../skill/SkillValidator';
import { expandHome } from '../../workspace/WorkspacePaths';
import {
  type AgentTool,
  requireStringInput,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskAssessment,
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
  /** Root used to resolve an explicit `--profile <name>` target. */
  profilesDir?: string;
  /** Reject profile-scoped writes to names that are not real profiles. */
  profileExists?: (profile: string) => boolean;
}

/** Workspace devices a source can be read from. Sources without a device
 * resolve on the workspace host, where this tool runs. */
export interface SkillSourceDevices {
  hostName: string;
  /** Resolve a device name or ID; throws when it is unknown or ambiguous. */
  resolve(device: string): { id: string; name: string; host: boolean };
  /** Read a skill source on a remote device and return its bundle. */
  fetch(deviceId: string, source: string): Promise<unknown>;
}

interface ResolvedSource {
  path: string;
  /** Where the source was read, for the result: `device:path` in a workspace. */
  label: string;
  cleanup?: () => void;
}

interface SkillManagementTarget {
  scope: SkillScope;
  profile?: string;
  store: SkillStore;
  /** The scope's skill directory. */
  dir: string;
}

/** Skill-local configuration files `configure` may write: dotfiles and TOML
 * files in the skill folder itself, never SKILL.md or a nested path. */
const CONFIG_FILE_NAME = /^(?:\.[A-Za-z0-9_][A-Za-z0-9_.-]*|[A-Za-z0-9_][A-Za-z0-9_.-]*\.toml)$/;
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const MAX_INSPECTED_FILES = 40;

/** Validated mutation boundary used by Marifold's protected management skills. */
export class SkillManagementTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'manage_skill',
    description: [
      'Create, install, update, remove, inspect, or configure a user-managed Marifold skill in the configured global skill directory or one explicitly named profile.',
      'When to use: Marifold skill management after the user invokes a protected management skill or explicitly asks the agent to change a skill.',
      'inspect lists installed skills with their files (no approval needed); use it instead of reading Marifold directories. configure writes one skill-local config file (a dotfile or *.toml such as .vars-path.toml) inside an installed skill, from content or copied from the same file in another installed skill.',
      'When NOT to use: running a skill, editing unrelated files, managing protected built-ins, fetching network sources, or changing both scopes at once.',
      'Global scope is the default user-facing scope; use profile scope only for an explicit --profile request. Pass the exact intended scope on every call.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'install', 'update', 'remove', 'inspect', 'configure'],
          description: 'The validated skill operation to perform.',
        },
        scope: {
          type: 'string',
          enum: ['profile', 'global'],
          description: 'Exact destination scope. Use global unless the user explicitly requested --profile <name>. Optional for inspect, which lists both scopes when omitted.',
        },
        profile: {
          type: 'string',
          description: 'Existing profile name. Include only when scope is profile; omit for global scope.',
        },
        name: {
          type: 'string',
          description: 'Required for create, update, remove, and configure. Must match the SKILL.md name for create/update. Optional filter for inspect.',
        },
        file: {
          type: 'string',
          description: 'configure only: the skill-local file name, a dotfile or *.toml in the skill folder (for example .vars-path.toml).',
        },
        copy_from: {
          type: 'string',
          description: 'configure only: name of another installed skill whose file of the same name is copied. Use instead of content.',
        },
        source: {
          type: 'string',
          description: 'Markdown file or folder containing SKILL.md. Required for install and update. Resolves on source_device, or on the workspace host when source_device is omitted.',
        },
        source_device: {
          type: 'string',
          description: 'Workspace runs only: the device that holds source, as a device name or ID from list_devices. Set it only when the user names a device (an @device mention, a device name, or "my current device"/"this computer" for the requesting device). Omit it otherwise: sources then resolve on the workspace host.',
        },
        content: {
          type: 'string',
          description: 'Complete SKILL.md text for create, or the file content for configure.',
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
      required: ['action'],
    },
  };

  private devices?: SkillSourceDevices;

  constructor(private readonly options: SkillManagementToolOptions) {}

  /** Let install/update read sources on other workspace devices. */
  useSourceDevices(devices: SkillSourceDevices): void {
    this.devices = devices;
  }

  summarizeCall(input: Record<string, JSONValue>): string {
    const action = typeof input.action === 'string' ? input.action : '<missing action>';
    const scope = typeof input.scope === 'string' ? input.scope : 'global';
    const scopeLabel = scope === 'profile' && typeof input.profile === 'string'
      ? `profile ${input.profile}`
      : scope;
    if (action === 'inspect') {
      const filter = typeof input.name === 'string' ? ` $${input.name}` : 's';
      return `inspect ${typeof input.scope === 'string' ? `${scopeLabel} ` : ''}skill${filter}`;
    }
    const source = typeof input.source === 'string'
      ? `${typeof input.source_device === 'string' ? `${input.source_device}:` : ''}${input.source}`
      : undefined;
    const target = typeof input.name === 'string'
      ? `$${input.name}${source && action === 'update' ? ` from ${source}` : ''}`
      : source ?? '<missing skill>';
    const file = action === 'configure' && typeof input.file === 'string' ? ` ${input.file}` : '';
    return `${action} ${scopeLabel} skill ${target}${file}`;
  }

  assessRisk(input: Record<string, JSONValue>): ToolRiskAssessment {
    // Listing installed skills reads only the skill directories runs may
    // already read; it never needs a prompt.
    if (input.action === 'inspect') { return { escalate: false, trusted: true }; }
    const scope = input.scope === 'profile' ? 'profile' : 'global';
    const profile = scope === 'profile' ? this.safeRequestedProfile(input.profile) : undefined;
    const dir = scope === 'global'
      ? this.options.globalDir
      : profile && this.options.profilesDir
        ? path.join(this.options.profilesDir, profile, 'skills')
        : this.options.profileDir;
    const suppliedName = typeof input.name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(input.name)
      ? input.name
      : undefined;
    const skillTarget = suppliedName ? path.join(dir, suppliedName) : dir;
    const target = input.action === 'configure' && suppliedName && typeof input.file === 'string' && CONFIG_FILE_NAME.test(input.file)
      ? path.join(skillTarget, input.file)
      : skillTarget;
    return {
      escalate: true,
      persistable: false,
      reason: scope === 'global'
        ? 'modifying the global Marifold skill directory'
        : `modifying Marifold skills for profile '${profile ?? this.options.profile}'`,
      targetPath: target,
    };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const action = requireStringInput(input, 'action', 'manage_skill');
      if (action === 'inspect') { return this.inspect(input); }
      const scope = skillScope(input.scope);
      const target = this.resolveTarget(input, scope);
      switch (action) {
        case 'create':
          return this.create(input, target);
        case 'install':
          return await this.withSource(input, ctx, source => this.install(source, target));
        case 'update':
          return await this.withSource(input, ctx, source => this.update(input, source, target));
        case 'remove':
          return this.remove(input, target);
        case 'configure':
          return this.configure(input, target);
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

  private create(input: Record<string, JSONValue>, target: SkillManagementTarget): ToolExecutionResult {
    const { scope, store } = target;
    const name = requireMutableName(input, 'name');
    const content = requireStringInput(input, 'content', 'manage_skill');
    const skill = parseSkill(content);
    if (skill.name !== name) {
      throw MarifoldError.skillInvalid(`Requested name '${name}' does not match SKILL.md name '${skill.name}'.`);
    }
    if (this.exactSkill(store, name, scope)) {
      throw MarifoldError.skillInvalid(
        `Skill '${name}' already exists in ${scope} scope. Choose another name or update it separately.`,
      );
    }
    const files = bundledTextFiles(input.files);
    const installed = store.installFromText(content, scope);
    const skillDir = path.dirname(installed.source!);
    try {
      for (const file of files) {
        const target = path.join(skillDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      this.verify(target, name);
    } catch (error) {
      store.remove(name, scope);
      throw error;
    }
    return {
      content: `Created $${name} in ${this.scopeLabel(target)} at ${skillDir}. Invoke it with $${name}.`,
      summary: `created ${scope} skill $${name}`,
    };
  }

  private async withSource(
    input: Record<string, JSONValue>,
    ctx: ToolExecutionContext,
    apply: (source: ResolvedSource) => ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    const source = await this.resolveSource(input, ctx);
    try {
      return apply(source);
    } finally {
      source.cleanup?.();
    }
  }

  private async resolveSource(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ResolvedSource> {
    const local = localSource(input, ctx);
    if (input.source_device === undefined) {
      return { path: local, label: this.devices ? `${this.devices.hostName}:${local}` : local };
    }
    const reference = requireStringInput(input, 'source_device', 'manage_skill');
    if (!this.devices) {
      throw MarifoldError.agentToolInvalid(
        "Tool 'manage_skill' accepts source_device only in a workspace run; omit it to use this device.",
        'manage_skill',
      );
    }
    const device = this.devices.resolve(reference);
    if (device.host) { return { path: local, label: `${device.name}:${local}` }; }
    const source = requireStringInput(input, 'source', 'manage_skill');
    const dir = stageSkillBundle(await this.devices.fetch(device.id, source));
    return {
      path: dir,
      label: `${device.name}:${source}`,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  private install(resolved: ResolvedSource, target: SkillManagementTarget): ToolExecutionResult {
    const { scope, store } = target;
    const source = resolved.path;
    const preview = readSkillSource(source);
    if (isBuiltInSkillName(preview.skill.name)) {
      throw protectedBuiltIn(preview.skill.name);
    }
    const existed = Boolean(this.exactSkill(store, preview.skill.name, scope));
    const installed = store.installFromFile(source, scope);
    this.verify(target, installed.name);
    const verb = existed ? 'Updated' : 'Installed';
    return {
      content: `${verb} $${installed.name} in ${this.scopeLabel(target)} at ${path.dirname(installed.source!)} from ${resolved.label}.`,
      summary: `${verb.toLowerCase()} ${scope} skill $${installed.name}`,
    };
  }

  private update(
    input: Record<string, JSONValue>,
    resolved: ResolvedSource,
    target: SkillManagementTarget,
  ): ToolExecutionResult {
    const { scope, store } = target;
    const name = requireMutableName(input, 'name');
    if (!this.exactSkill(store, name, scope)) {
      throw MarifoldError.skillInvalid(`Skill '${name}' does not exist in ${scope} scope.`);
    }
    const source = resolved.path;
    const preview = readSkillSource(source);
    if (preview.skill.name !== name) {
      throw MarifoldError.skillInvalid(
        `Update source name '${preview.skill.name}' does not match requested skill '${name}'.`,
      );
    }
    const installed = store.installFromFile(source, scope);
    this.verify(target, name);
    return {
      content: `Updated $${name} in ${this.scopeLabel(target)} at ${path.dirname(installed.source!)} from ${resolved.label}.`,
      summary: `updated ${scope} skill $${name}`,
    };
  }

  private remove(input: Record<string, JSONValue>, target: SkillManagementTarget): ToolExecutionResult {
    const { scope, store } = target;
    const name = requireMutableName(input, 'name');
    const existing = this.exactSkill(store, name, scope);
    if (!existing) {
      throw MarifoldError.skillInvalid(`Skill '${name}' does not exist in ${scope} scope.`);
    }
    const removedDir = path.dirname(existing.source!);
    store.remove(name, scope);
    const effective = store.get(name);
    const fallback = effective
      ? ` The ${effective.scope} copy at ${path.dirname(effective.source!)} is now effective.`
      : ' No user-managed copy remains effective.';
    return {
      content: `Removed $${name} from ${this.scopeLabel(target)} at ${removedDir}.${fallback}`,
      summary: `removed ${scope} skill $${name}`,
    };
  }

  private inspect(input: Record<string, JSONValue>): ToolExecutionResult {
    const filter = input.name === undefined ? undefined : requireStringInput(input, 'name', 'manage_skill');
    const scopes: SkillScope[] = input.scope === undefined ? ['global', 'profile'] : [skillScope(input.scope)];
    const sections = scopes.map((scope) => {
      // Without an explicit scope, a profile argument narrows only the profile section.
      const scopedInput = scope === 'global' && input.scope === undefined
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'profile'))
        : input;
      const target = this.resolveTarget(scopedInput, scope);
      const skills = target.store.list(scope).filter(skill => filter === undefined || skill.name === filter);
      const lines = skills.map((skill) => {
        const files = listSkillFiles(path.dirname(skill.source!));
        return `- $${skill.name}: ${files.length > 0 ? files.join(', ') : 'SKILL.md only'}`;
      });
      return `${this.scopeLabel(target)} (${target.dir}):\n${lines.length > 0 ? lines.join('\n') : '- no skills'}`;
    });
    return {
      content: `${sections.join('\n\n')}\n\nProfile skills shadow global skills with the same name. Use configure to set a skill-local file such as .vars-path.toml.`,
      summary: filter === undefined ? 'listed installed skills' : `inspected skill $${filter}`,
    };
  }

  private configure(input: Record<string, JSONValue>, target: SkillManagementTarget): ToolExecutionResult {
    const name = requireMutableName(input, 'name');
    const existing = this.exactSkill(target.store, name, target.scope);
    if (!existing) {
      throw MarifoldError.skillInvalid(`Skill '${name}' does not exist in ${target.scope} scope.`);
    }
    const file = requireStringInput(input, 'file', 'manage_skill');
    if (!CONFIG_FILE_NAME.test(file)) {
      throw MarifoldError.skillInvalid(
        `'${file}' is not a skill-local config file. Use a dotfile or a *.toml file name in the skill folder, without a path.`,
      );
    }
    const skillDir = fs.realpathSync(path.dirname(existing.source!));
    if (!isInside(skillDir, fs.realpathSync(target.dir))) {
      throw MarifoldError.skillInvalid(`Skill '${name}' resolves outside the ${target.scope} skill directory.`);
    }
    let content: string;
    let origin = '';
    if (input.copy_from !== undefined) {
      if (input.content !== undefined) {
        throw MarifoldError.agentToolInvalid("Tool 'manage_skill' accepts content or copy_from, not both.", 'manage_skill');
      }
      const sourceName = requireStringInput(input, 'copy_from', 'manage_skill');
      const source = target.store.get(sourceName);
      if (!source?.source) {
        throw MarifoldError.skillInvalid(`Skill '${sourceName}' is not installed.`);
      }
      content = readRegularConfigFile(path.join(path.dirname(source.source), file), `Skill '${sourceName}' has no ${file}.`);
      origin = ` copied from $${sourceName}`;
    } else {
      content = requireStringInput(input, 'content', 'manage_skill');
    }
    if (Buffer.byteLength(content) > MAX_CONFIG_FILE_BYTES) {
      throw MarifoldError.skillInvalid(`${file} exceeds ${MAX_CONFIG_FILE_BYTES / 1024} KB.`);
    }
    const destination = path.join(skillDir, file);
    const current = lstatOrUndefined(destination);
    if (current && !current.isFile()) {
      throw MarifoldError.skillInvalid(`${destination} exists and is not a regular file.`);
    }
    const fd = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return {
      content: `${current ? 'Updated' : 'Created'} ${destination}${origin} for $${name} in ${this.scopeLabel(target)}.`,
      summary: `configured ${target.scope} skill $${name} ${file}`,
    };
  }

  private exactSkill(store: SkillStore, name: string, scope: SkillScope) {
    return store.list(scope).find(skill => skill.name === name);
  }

  private verify(target: SkillManagementTarget, name: string): void {
    if (!this.exactSkill(target.store, name, target.scope)) {
      throw MarifoldError.skillInvalid(`Could not verify '${name}' after writing ${target.scope} scope.`);
    }
  }

  private resolveTarget(input: Record<string, JSONValue>, scope: SkillScope): SkillManagementTarget {
    if (scope === 'global') {
      if (input.profile !== undefined) {
        throw MarifoldError.agentToolInvalid(
          "Tool 'manage_skill' cannot combine global scope with a profile.",
          'manage_skill',
        );
      }
      return {
        scope,
        store: this.options.store,
        dir: this.options.globalDir,
      };
    }

    const profile = input.profile === undefined
      ? this.options.profile
      : requireStringInput(input, 'profile', 'manage_skill');
    if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
      throw MarifoldError.skillInvalid(`Invalid profile name '${profile}'.`);
    }
    if (profile !== this.options.profile) {
      if (!this.options.profilesDir || !this.options.profileExists?.(profile)) {
        throw MarifoldError.skillInvalid(`Profile '${profile}' does not exist.`);
      }
    }
    const directory = profile === this.options.profile
      ? this.options.profileDir
      : path.join(this.options.profilesDir!, profile, 'skills');
    return {
      scope,
      profile,
      dir: directory,
      store: profile === this.options.profile
        ? this.options.store
        : new SkillStore({ globalDir: this.options.globalDir, profileDir: directory }),
    };
  }

  private safeRequestedProfile(value: JSONValue | undefined): string | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
      ? value
      : this.options.profile;
  }

  private scopeLabel(target: SkillManagementTarget): string {
    return target.scope === 'global' ? 'global scope' : `profile '${target.profile}'`;
  }
}

function skillScope(value: JSONValue | undefined): SkillScope {
  if (value === 'profile' || value === 'global') { return value; }
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
  if (isBuiltInSkillName(name)) { throw protectedBuiltIn(name); }
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
  if (value === undefined) { return []; }
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

function listSkillFiles(skillDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_INSPECTED_FILES) { return; }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relative);
      } else if (relative !== 'SKILL.md') {
        files.push(relative);
      }
    }
  };
  walk(skillDir, '');
  return files.length >= MAX_INSPECTED_FILES ? [...files, '…'] : files;
}

function readRegularConfigFile(file: string, missing: string): string {
  const stat = lstatOrUndefined(file);
  if (!stat) { throw MarifoldError.skillInvalid(missing); }
  if (!stat.isFile()) { throw MarifoldError.skillInvalid(`${file} is not a regular file.`); }
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw MarifoldError.skillInvalid(`${file} exceeds ${MAX_CONFIG_FILE_BYTES / 1024} KB.`);
  }
  return fs.readFileSync(file, 'utf-8');
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    throw error;
  }
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
