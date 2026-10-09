import { describe, expect, it, vi } from 'vitest';
import { TailscaleControl } from '../src/agent/TailscaleControl';

function commands() {
  return vi.fn(async (file: string, args: string[]): Promise<string> => {
    if (file.endsWith('PlistBuddy')) { return 'io.tailscale.ipn.macsys\n'; }
    if (args[0] === 'status') { return '{"BackendState":"Running"}'; }
    return '';
  });
}
describe('standalone macOS Tailscale restart', () => {
  it('checks variant, signature, and existing sudo permission without stopping anything', async () => {
    const run = commands();
    expect(await new TailscaleControl(run, 'darwin').check()).toEqual({ canRestart: true });
    expect(run.mock.calls.at(-1)?.[1]).toContain('-l');
    // codesign treats an unprefixed requirement as a filename.
    expect(run.mock.calls.find(([file]) => file.endsWith('codesign'))?.[1]).toContain('=anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB"');
    expect(run.mock.calls.some(([, args]) => args[0] === 'rungui')).toBe(false);
  });
  it('refuses before stopping when administrator permission is unavailable', async () => {
    const run = commands().mockImplementation(async file => {
      if (file.endsWith('PlistBuddy')) { return 'io.tailscale.ipn.macsys'; }
      if (file.endsWith('sudo')) { throw new Error('password required'); }
      return '';
    });
    await expect(new TailscaleControl(run, 'darwin').restart()).rejects.toThrow('password required');
    expect(run.mock.calls.filter(([file]) => file.endsWith('sudo'))).toHaveLength(1);
  });
  it('does not use this workflow for the App Store variant or Linux', async () => {
    const run = commands().mockResolvedValue('io.tailscale.ipn.macos');
    expect((await new TailscaleControl(run, 'darwin').check()).canRestart).toBe(false);
    run.mockClear();
    expect((await new TailscaleControl(run, 'linux').check()).canRestart).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('restores after an uncertain stop, retries only startup, and separates VPN readiness from restart success', async () => {
    let starts = 0;
    const run = commands().mockImplementation(async (file, args) => {
      if (file.endsWith('PlistBuddy')) { return 'io.tailscale.ipn.macsys'; }
      if (file.endsWith('sudo') && !args.includes('-l')) { throw new Error('stop timeout'); }
      if (args[0] === 'rungui' && ++starts === 1) { throw new Error('startup failed'); }
      if (args[0] === 'status') { return '{"BackendState":"Running"}'; }
      return '';
    });
    expect(await new TailscaleControl(run, 'darwin').restart()).toMatchObject({ restarted: false, vpnReady: true, recoveryAttempted: true });
    expect(starts).toBe(2);
    expect(run.mock.calls.filter(([file, args]) => file.endsWith('sudo') && !args.includes('-l'))).toHaveLength(1);
  });
  it('reports successful command restart separately from a disconnected VPN', async () => {
    const run = commands().mockImplementation(async (file, args) => {
      if (file.endsWith('PlistBuddy')) { return 'io.tailscale.ipn.macsys'; }
      if (args[0] === 'status') { return '{"BackendState":"NeedsLogin"}'; }
      return '';
    });
    expect(await new TailscaleControl(run, 'darwin').restart()).toEqual({ restarted: true, vpnReady: false, recoveryAttempted: true, errors: [] });
  });
});
