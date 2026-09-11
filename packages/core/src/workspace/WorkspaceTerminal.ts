import { record } from '@marifold/workspace-protocol';
import type { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import type { ToolKind, ApprovalMode } from '../agent/ApprovalPolicy';

/** Explicit terminal operations; deliberately no arbitrary runtime-method RPC. */
export async function workspaceTerminal(runtime: MarifoldRuntime, operation: string, value: unknown): Promise<unknown> {
  const b = record(value);
  const text = (key: string, optional = false): string => {
    const v = b[key];
    if (optional && v === undefined) return '';
    if (typeof v !== 'string' || v.length > 1024 * 1024) throw new Error(`Invalid ${key}.`);
    return v;
  };
  const profile = () => {
    const name = text('profile');
    runtime.getProfile(name);
    return name;
  };
  const scope = () => {
    if (b.scope !== 'global' && b.scope !== 'profile') throw new Error('Invalid skill scope.');
    return b.scope;
  };
  switch (operation) {
    case 'snapshot':
      return runtime.listProfiles().map((p) => {
        let settings;
        try {
          settings = runtime.resolveSettings({ profile: p.name });
        } catch {
          /* Unconfigured profiles remain selectable for configuration. */
        }
        return {
          summary: p,
          detail: runtime.getProfile(p.name),
          settings,
          agent: runtime.resolveAgentConfigForProfile(p.name),
          skills: {
            all: runtime.listSkills(p.name),
            global: runtime.listSkills(p.name, 'global'),
            profile: runtime.listSkills(p.name, 'profile'),
          },
        };
      });
    case 'skill.install':
      return runtime.installSkillFromText(text('text'), scope(), profile());
    case 'skill.remove':
      return runtime.removeSkill(text('name'), profile(), scope());
    case 'profile.migrate':
      return runtime.migrateProfileInstructions(profile());
    case 'profile.approval': {
      const kind = text('kind');
      const mode = text('mode');
      if (!['read', 'write', 'shell', 'network', 'delegate'].includes(kind) || !['allow', 'ask', 'deny'].includes(mode))
        throw new Error('Invalid approval policy.');
      return runtime.setProfileAgentApproval(profile(), kind as ToolKind, mode as ApprovalMode);
    }
    case 'profile.trust':
      return runtime.addProfileTrustedFolder(profile(), text('folder'));
    case 'profile.context': {
      if (
        b.tokens !== undefined &&
        b.tokens !== null &&
        (typeof b.tokens !== 'number' || !Number.isSafeInteger(b.tokens) || b.tokens <= 0)
      )
        throw new Error('Invalid context budget.');
      return runtime.setProfileMaxContextTokens(profile(), typeof b.tokens === 'number' ? b.tokens : undefined);
    }
    case 'memory.remember':
      return runtime.rememberMemory(profile(), 'auto_short', text('text'), text('sessionId', true) || undefined);
    case 'memory.forget':
      return runtime.forgetMemories(profile(), text('query'));
    case 'memory.delete':
      return runtime.deleteMemories(profile(), text('query'));
    default:
      throw new Error('Unsupported terminal operation.');
  }
}
