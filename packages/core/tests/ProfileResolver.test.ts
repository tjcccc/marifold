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
  it('loads priests-style profile directories', () => {
    const root = tempDir();
    const profileDir = path.join(root, 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Rules');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Custom');

    const profile = new ProfileResolver(root).load('default');

    expect(profile.identity).toBe('Identity');
    expect(profile.rules).toBe('Rules');
    expect(profile.custom).toBe('Custom');
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

  it('returns the built-in default profile when no default profile exists', () => {
    const root = tempDir();

    const profile = new ProfileResolver(root).load('default');
    const list = new ProfileResolver(root).list();

    expect(profile.name).toBe('default');
    expect(list).toEqual([{ name: 'default', source: 'built-in' }]);
  });
});
