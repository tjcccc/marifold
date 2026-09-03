import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileResolver, ProfileManager } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProfileResolver', () => {
  it('combines legacy split profile directories in their effective order', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Custom');

    const profile = new ProfileResolver(root).load('default');

    expect(profile.identity).toBe('Rules\n\nIdentity\n\nCustom');
    expect(profile.rules).toBe('');
    expect(profile.custom).toBe('');
  });

  it('prefers INSTRUCTIONS.md even when it is empty', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), '');
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Legacy identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Legacy rules');

    const resolver = new ProfileResolver(root);
    const profile = resolver.load('default');
    const detail = resolver.detail('default');

    expect(profile.identity).toBe('');
    expect(detail.instructionFormat).toBe('unified');
    expect(detail.legacyInstructionFiles).toEqual(['PROFILE.md', 'RULES.md']);
    expect(detail.files.instructions.content).toBe('');
    expect(detail.files.profile.content).toBe('');
    expect(detail.files.rules.content).toBe('');
  });

  it('loads profile provider/model overrides from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'coder');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Coder');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\n');

    const settings = new ProfileResolver(root).loadSettings('coder');

    expect(settings).toEqual({ provider: 'ollama', model: 'codellama', memories: true });
  });

  it('resolves display names from profile.toml and falls back to the profile name', () => {
    const root = tempDir();
    const namedDir = path.join(root, 'writer');
    const plainDir = path.join(root, 'plain');
    fs.mkdirSync(namedDir, { recursive: true });
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(namedDir, 'profile.toml'), 'display_name = "Writing Partner"\n');
    fs.writeFileSync(path.join(plainDir, 'profile.toml'), 'memories = true\n');

    const resolver = new ProfileResolver(root);
    expect(resolver.detail('writer')).toMatchObject({
      name: 'writer',
      displayName: 'Writing Partner',
      settings: { displayName: 'Writing Partner' },
    });
    expect(resolver.detail('plain')).toMatchObject({
      name: 'plain',
      displayName: 'plain',
    });
    expect(resolver.detail('plain').settings.displayName).toBeUndefined();
  });

  it('persists and clears a display-name override while preserving profile settings', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\n');

    const manager = new ProfileManager(root);
    manager.setDisplayName('writer', '  Writing Partner  ');
    expect(new ProfileResolver(root).detail('writer')).toMatchObject({
      displayName: 'Writing Partner',
      settings: { displayName: 'Writing Partner', memories: false },
    });

    manager.setDisplayName('writer', '');
    expect(new ProfileResolver(root).detail('writer')).toMatchObject({ displayName: 'writer' });
    expect(new ProfileResolver(root).loadSettings('writer').displayName).toBeUndefined();
    expect(new ProfileResolver(root).loadSettings('writer').memories).toBe(false);
  });

  it('loads profile memory enablement from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'tool');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Formatter');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\n');

    const settings = new ProfileResolver(root).loadSettings('tool');

    expect(settings).toEqual({ memories: false });
  });

  it('shows profile file details and settings', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Writer identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Writer rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Writer custom');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'provider = "ollama"\nmodel = "gemma4:e4b"\n');

    const detail = new ProfileResolver(root).detail('writer');

    expect(detail.name).toBe('writer');
    expect(detail.settings).toEqual({ provider: 'ollama', model: 'gemma4:e4b', memories: true });
    expect(detail.instructionFormat).toBe('legacy');
    expect(detail.legacyInstructionFiles).toEqual(['PROFILE.md', 'RULES.md', 'CUSTOM.md']);
    expect(detail.files.instructions.content).toBe('Writer rules\n\nWriter identity\n\nWriter custom');
    expect(detail.files.profile.content).toBe('Writer identity');
    expect(detail.files.rules.content).toBe('Writer rules');
    expect(detail.files.custom.content).toBe('Writer custom');
  });

  it('loads the profile default mode from profile.toml', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'reader');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = true\nmode = "chat"\n');

    const settings = new ProfileResolver(root).loadSettings('reader');

    expect(settings.mode).toBe('chat');
  });

  it('rejects an invalid profile mode', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'broken');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'mode = "wizard"\n');

    expect(() => new ProfileResolver(root).loadSettings('broken')).toThrow(/invalid mode/i);
  });

  it('persists a default mode via ProfileManager and preserves other keys', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'coder');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\nprovider = "ollama"\nmodel = "codellama"\n');

    const result = new ProfileManager(root).setMode('coder', 'chat');
    const settings = new ProfileResolver(root).loadSettings('coder');

    expect(result.mode).toBe('chat');
    expect(settings).toEqual({ provider: 'ollama', model: 'codellama', memories: false, mode: 'chat' });
  });

  it('persists a per-profile approval via ProfileManager and preserves other keys', () => {
    const root = tempDir();
    const dir = path.join(root, 'helper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\nmode = "agent"\n');

    new ProfileManager(root).setAgentApproval('helper', 'shell', 'allow');
    const settings = new ProfileResolver(root).loadSettings('helper');

    expect(settings.agent?.approval?.shell).toBe('allow');
    expect(settings.provider).toBe('ollama');
    expect(settings.model).toBe('codellama');
    expect(settings.mode).toBe('agent');

    // Re-setting the same kind replaces (no duplicate key -> still parses).
    new ProfileManager(root).setAgentApproval('helper', 'shell', 'deny');
    expect(new ProfileResolver(root).loadSettings('helper').agent?.approval?.shell).toBe('deny');
  });

  it('adds a trusted folder and round-trips it (refusing sensitive roots)', () => {
    const root = tempDir();
    const dir = path.join(root, 'blogger');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\n');

    const pm = new ProfileManager(root);
    pm.addTrustedFolder('blogger', '/tmp/my-blog');
    pm.addTrustedFolder('blogger', '/tmp/other');
    const settings = new ProfileResolver(root).loadSettings('blogger');
    expect(settings.agent?.trustedFolders).toEqual(['/tmp/my-blog', '/tmp/other']);
    expect(settings.provider).toBe('ollama'); // other keys preserved

    // Re-adding is idempotent (no duplicate -> still parses).
    pm.addTrustedFolder('blogger', '/tmp/my-blog');
    expect(new ProfileResolver(root).loadSettings('blogger').agent?.trustedFolders).toEqual(['/tmp/my-blog', '/tmp/other']);

    // Sensitive / too-broad roots are refused.
    expect(() => pm.addTrustedFolder('blogger', os.homedir())).toThrow(/too broad|sensitive/i);
    expect(() => pm.addTrustedFolder('blogger', '/')).toThrow(/too broad|sensitive/i);
    expect(() => pm.addTrustedFolder('blogger', path.join(os.homedir(), '.ssh'))).toThrow(/too broad|sensitive/i);
  });

  it('persists approval for a profile with no pre-existing directory (e.g. default)', () => {
    const root = tempDir();
    // No profiles/default/ dir — as a fresh workspace's built-in default profile.
    new ProfileManager(root).setAgentApproval('default', 'shell', 'allow');
    expect(fs.existsSync(path.join(root, 'default', 'profile.toml'))).toBe(true);
    expect(new ProfileResolver(root).loadSettings('default').agent?.approval?.shell).toBe('allow');
  });

  it('parses session_context_turns as an integer turn window', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'x-runner');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'session_context_turns = 5\n');

    expect(new ProfileResolver(root).loadSettings('x-runner').sessionContextTurns).toBe(5);
  });

  it('parses a per-profile [agent] approval override (dotted or table form)', () => {
    const root = tempDir();
    const dottedDir = path.join(root, 'helper');
    fs.mkdirSync(dottedDir, { recursive: true });
    fs.writeFileSync(path.join(dottedDir, 'profile.toml'), 'agent.approval.shell = "allow"\n');
    expect(new ProfileResolver(root).loadSettings('helper').agent?.approval?.shell).toBe('allow');

    const tableDir = path.join(root, 'writer');
    fs.mkdirSync(tableDir, { recursive: true });
    fs.writeFileSync(path.join(tableDir, 'profile.toml'), '[agent.approval]\nshell = "deny"\nwrite = "ask"\n');
    const writer = new ProfileResolver(root).loadSettings('writer').agent;
    expect(writer?.approval).toMatchObject({ shell: 'deny', write: 'ask' });

    const plain = path.join(root, 'plain2');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'profile.toml'), 'memories = true\n');
    expect(new ProfileResolver(root).loadSettings('plain2').agent).toBeUndefined();
  });

  it('rejects an invalid per-profile approval mode', () => {
    const root = tempDir();
    const dir = path.join(root, 'broken-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.toml'), 'agent.approval.shell = "maybe"\n');
    expect(() => new ProfileResolver(root).loadSettings('broken-agent')).toThrow(/allow.*ask.*deny/i);
  });

  it('parses a per-profile think override (and leaves it undefined when unset)', () => {
    const root = tempDir();
    const onDir = path.join(root, 'thinker');
    fs.mkdirSync(onDir, { recursive: true });
    fs.writeFileSync(path.join(onDir, 'profile.toml'), 'think = true\n');
    expect(new ProfileResolver(root).loadSettings('thinker').think).toBe(true);

    const offDir = path.join(root, 'plain');
    fs.mkdirSync(offDir, { recursive: true });
    fs.writeFileSync(path.join(offDir, 'profile.toml'), 'memories = true\n');
    expect(new ProfileResolver(root).loadSettings('plain').think).toBeUndefined();
  });

  it('treats session_context_turns = "all" as no cap (undefined) and accepts 0', () => {
    const root = tempDir();
    const allDir = path.join(root, 'full');
    fs.mkdirSync(allDir, { recursive: true });
    fs.writeFileSync(path.join(allDir, 'profile.toml'), 'session_context_turns = "all"\n');
    expect(new ProfileResolver(root).loadSettings('full').sessionContextTurns).toBeUndefined();

    const zeroDir = path.join(root, 'fresh');
    fs.mkdirSync(zeroDir, { recursive: true });
    fs.writeFileSync(path.join(zeroDir, 'profile.toml'), 'session_context_turns = 0\n');
    expect(new ProfileResolver(root).loadSettings('fresh').sessionContextTurns).toBe(0);
  });

  it('rejects an invalid session_context_turns value', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'bad');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'session_context_turns = -2\n');

    expect(() => new ProfileResolver(root).loadSettings('bad')).toThrow(/non-negative integer or "all"/i);
  });

  it('writes canonical instructions and keeps legacy aliases compatible', () => {
    const root = tempDir();
    const pm = new ProfileManager(root);

    pm.writeProfileFile('editor-test', 'rules', '# New rules\nBe terse.');
    pm.writeProfileFile('editor-test', 'custom', 'Extra guidance.');
    pm.writeProfileFile('editor-test', 'instructions', '# Unified\nDo the work.');

    expect(fs.readFileSync(path.join(root, 'editor-test', 'RULES.md'), 'utf-8')).toBe('# New rules\nBe terse.');
    expect(fs.readFileSync(path.join(root, 'editor-test', 'CUSTOM.md'), 'utf-8')).toBe('Extra guidance.');
    expect(fs.readFileSync(path.join(root, 'editor-test', 'INSTRUCTIONS.md'), 'utf-8')).toBe('# Unified\nDo the work.');
    expect(() => pm.writeProfileFile('editor-test', 'rules', 'ignored')).toThrow(/uses INSTRUCTIONS\.md/);
    pm.writeProfileFile('editor-test', 'profile', '# Updated unified');
    expect(fs.readFileSync(path.join(root, 'editor-test', 'INSTRUCTIONS.md'), 'utf-8')).toBe('# Updated unified');
    expect(() => pm.writeProfileFile('editor-test', 'nope' as never, 'x')).toThrow(/Unknown profile file/);
  });

  it('backs up and migrates legacy profile instructions idempotently', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Custom');
    const pm = new ProfileManager(root);

    const result = pm.migrateProfileInstructions('writer');

    expect(result.status).toBe('migrated');
    expect(fs.readFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), 'utf-8')).toBe('Rules\n\nIdentity\n\nCustom');
    expect(fs.existsSync(path.join(profileDir, 'PROFILE.md'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, 'RULES.md'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, 'CUSTOM.md'))).toBe(false);
    expect(result.backupPath).toBeTruthy();
    expect(fs.readFileSync(path.join(result.backupPath!, 'PROFILE.md'), 'utf-8')).toBe('Identity');
    expect(pm.migrateProfileInstructions('writer').status).toBe('unchanged');
    expect(new ProfileResolver(root).detail('writer')).toMatchObject({
      instructionFormat: 'unified',
      legacyInstructionFiles: [],
    });
  });

  it('cleans backed-up legacy files without replacing existing unified instructions', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), 'Canonical');
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Stale identity');

    const result = new ProfileManager(root).migrateProfileInstructions('writer');

    expect(result.status).toBe('cleaned');
    expect(fs.readFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), 'utf-8')).toBe('Canonical');
    expect(fs.existsSync(path.join(profileDir, 'PROFILE.md'))).toBe(false);
    expect(fs.readFileSync(path.join(result.backupPath!, 'PROFILE.md'), 'utf-8')).toBe('Stale identity');
  });

  it('removes a trusted folder and clears the line when the list empties', () => {
    const root = tempDir();
    const dir = path.join(root, 'blogger');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\n');

    const pm = new ProfileManager(root);
    pm.addTrustedFolder('blogger', '/tmp/my-blog');
    pm.addTrustedFolder('blogger', '/tmp/other');

    const removed = pm.removeTrustedFolder('blogger', '/tmp/my-blog');
    expect(removed.removed).toBe(true);
    expect(new ProfileResolver(root).loadSettings('blogger').agent?.trustedFolders).toEqual(['/tmp/other']);

    expect(pm.removeTrustedFolder('blogger', '/tmp/absent').removed).toBe(false);
    pm.removeTrustedFolder('blogger', '/tmp/other');
    const settings = new ProfileResolver(root).loadSettings('blogger');
    expect(settings.agent?.trustedFolders ?? []).toEqual([]);
    expect(settings.provider).toBe('ollama'); // other keys preserved throughout
  });

  it('clears a per-profile approval override with mode undefined (inherit again)', () => {
    const root = tempDir();
    const pm = new ProfileManager(root);
    pm.setAgentApproval('helper2', 'shell', 'allow');
    expect(new ProfileResolver(root).loadSettings('helper2').agent?.approval?.shell).toBe('allow');

    pm.setAgentApproval('helper2', 'shell', undefined);
    expect(new ProfileResolver(root).loadSettings('helper2').agent?.approval?.shell).toBeUndefined();
  });

  it('sets and clears memories / think / session_context_turns via ProfileManager', () => {
    const root = tempDir();
    const dir = path.join(root, 'tuner');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.toml'), 'provider = "ollama"\nmodel = "codellama"\n');
    const pm = new ProfileManager(root);

    pm.setMemories('tuner', false);
    pm.setThink('tuner', true);
    pm.setSessionContextTurns('tuner', 5);
    let settings = new ProfileResolver(root).loadSettings('tuner');
    expect(settings).toMatchObject({ memories: false, think: true, sessionContextTurns: 5, provider: 'ollama' });

    pm.setThink('tuner', undefined);
    pm.setSessionContextTurns('tuner', 'all');
    settings = new ProfileResolver(root).loadSettings('tuner');
    expect(settings.think).toBeUndefined();
    expect(settings.sessionContextTurns).toBeUndefined();

    expect(() => pm.setSessionContextTurns('tuner', -1)).toThrow(/non-negative integer/);
    expect(() => pm.setSessionContextTurns('tuner', 2.5)).toThrow(/non-negative integer/);
  });

  it('returns the built-in default profile when no default profile exists', () => {
    const root = tempDir();

    const profile = new ProfileResolver(root).load('default');
    const list = new ProfileResolver(root).list();

    expect(profile.name).toBe('default');
    expect(list).toEqual([{ name: 'default', displayName: 'default', source: 'built-in' }]);
  });

  it('stores, replaces, flags, and deletes profile avatars', () => {
    const root = tempDir();
    const pm = new ProfileManager(root);
    pm.init('painter');

    // Validation: type and size (ceiling is 2 MB).
    expect(() => pm.setAvatar('painter', Buffer.from('x'), 'image/tiff')).toThrow(/Unsupported avatar type/);
    expect(() => pm.setAvatar('painter', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png')).toThrow(/between 1 byte/);

    // Store under assets/, then replace with a different extension — old file goes away.
    pm.setAvatar('painter', Buffer.from('png-bytes'), 'image/png');
    expect(pm.avatar('painter')).toMatchObject({ mediaType: 'image/png' });
    expect(fs.existsSync(path.join(root, 'painter', 'assets', 'avatar.png'))).toBe(true);
    pm.setAvatar('painter', Buffer.from('webp-bytes'), 'image/webp');
    expect(fs.existsSync(path.join(root, 'painter', 'assets', 'avatar.png'))).toBe(false);
    expect(pm.avatar('painter')).toMatchObject({ mediaType: 'image/webp' });

    // Summaries carry the flag; profiles without avatars stay clean.
    const summaries = new ProfileResolver(root).list();
    expect(summaries.find(p => p.name === 'painter')?.avatar).toEqual({ mediaType: 'image/webp' });
    expect(summaries.find(p => p.name === 'default')?.avatar).toBeUndefined();

    // The built-in default (no md/toml files) can still hold an avatar.
    pm.setAvatar('default', Buffer.from('d'), 'image/jpeg');
    expect(new ProfileResolver(root).list().find(p => p.name === 'default')).toMatchObject({
      source: 'built-in',
      avatar: { mediaType: 'image/jpeg' },
    });

    expect(pm.deleteAvatar('painter')).toEqual({ name: 'painter', removed: true });
    expect(pm.deleteAvatar('painter')).toEqual({ name: 'painter', removed: false });
    expect(pm.avatar('painter')).toBeUndefined();
  });

  it('reads avatars only from assets/ (root-level avatars are not a supported location)', () => {
    const root = tempDir();
    const pm = new ProfileManager(root);
    pm.init('rooted');
    // A stray root-level avatar is ignored — assets/ is the only location.
    fs.writeFileSync(path.join(root, 'rooted', 'avatar.png'), Buffer.from('stray'));
    expect(pm.avatar('rooted')).toBeUndefined();
  });
});
