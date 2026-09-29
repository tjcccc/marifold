import { afterEach, describe, expect, it, vi } from 'vitest';
import { SudoCredentials, encryptSudoPassword, parseSudoResponse } from '../src/agent/SudoCredentials';
import { SudoExecTool } from '../src/agent/tools/SudoExecTool';
import { DeviceExecution } from '../src/agent/DeviceExecution';

afterEach(() => vi.restoreAllMocks());
describe('ephemeral sudo credentials', () => {
  it('decrypts only on the target and only once for the exact command', () => {
    const target = new SudoCredentials();
    const request = target.create('id -u');
    const response = encryptSudoPassword(request, 'test-password-canary');
    expect(JSON.stringify({ request, response })).not.toContain('test-password-canary');
    expect(() => new SudoCredentials().consume('id -u', response)).toThrow();
    const bytes = target.consume('id -u', response);
    expect(bytes.toString()).toBe('test-password-canary');
    bytes.fill(0);
    expect(() => target.consume('id -u', response)).toThrow('consumed');
    const other = encryptSudoPassword(target.create('id -u'), 'different-password');
    expect(() => target.consume('rm something', other)).toThrow('another command');
    expect(() => target.consume('id -u', other)).toThrow('consumed');
  });
  it('rejects expiry, malformed ciphertext, and line breaks without exposing submitted values', () => {
    const target = new SudoCredentials();
    const request = target.create('true');
    const response = encryptSudoPassword(request, 'canary');
    vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1);
    expect(() => target.consume('true', response)).toThrow('expired');
    expect(() => encryptSudoPassword(request, 'secret')).toThrow('expired');
    expect(() => parseSudoResponse({ id: request.id, password: 'never-accept-plaintext' })).toThrow('Invalid encrypted');
    expect(() => encryptSudoPassword(request, 'bad\nvalue')).toThrow('line breaks');
  });
  it('requires full access and passes credentials only to the private worker channel', async () => {
    const device = new DeviceExecution('/unused-test-config.toml');
    vi.spyOn(device, 'mode').mockReturnValue('scoped');
    const tool = new SudoExecTool(device);
    const ctx = { cwd: '/tmp', outputLimit: 1000 };
    expect(tool.assessRisk({ command: 'id -u' }, ctx)).toMatchObject({ blocked: true });
    vi.spyOn(device, 'mode').mockReturnValue('full');
    const risk = tool.assessRisk({ command: 'id -u' }, ctx);
    expect(risk).toMatchObject({ escalate: true, persistable: false });
    const response = encryptSudoPassword(risk.sudo!, 'canary-password');
    let passed: Buffer | undefined;
    vi.spyOn(device, 'start').mockImplementation(async (_command, _cwd, env, password) => {
      passed = password;
      expect(password?.toString()).toBe('canary-password');
      expect(JSON.stringify(env)).not.toContain('canary-password');
      return { id: 'job', state: 'queued', createdAt: 'now' };
    });
    await expect(tool.execute({ command: 'id -u' }, ctx)).rejects.toThrow('fresh secure');
    await expect(tool.execute({ command: 'id -u' }, { ...ctx, signal: AbortSignal.abort(), sudoResponse: response })).rejects.toThrow('cancelled');
    const result = await tool.execute({ command: 'id -u' }, { ...ctx, sudoResponse: response });
    expect(result.content).not.toContain('canary-password');
    expect(passed?.every(byte => byte === 0)).toBe(true);
    await expect(tool.execute({ command: 'id -u' }, { ...ctx, sudoResponse: response })).rejects.toThrow('consumed');
    expect(() => tool.assessRisk({ command: 'id', password: 'secret' }, ctx)).toThrow('only a command');
  });
});
