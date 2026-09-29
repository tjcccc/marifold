import { execFile } from 'node:child_process';

const APP = '/Applications/Tailscale.app';
const CLI = `${APP}/Contents/MacOS/Tailscale`;
type Command = (file: string, args: string[]) => Promise<string>;
const execute: Command = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error(`${file} ${args[0] ?? ''} failed or timed out.`));
    else resolve(stdout);
  });
});

/** Optional fixed workflow, also usable through ordinary full-access shell.
 * No privilege is installed or inferred from a Marifold approval. */
export class TailscaleControl {
  constructor(private readonly command: Command = execute, private readonly platform = process.platform) {}

  async check(): Promise<{ canRestart: boolean; reason?: string }> {
    if (this.platform !== 'darwin') return { canRestart: false, reason: 'This workflow supports the standalone macOS app from tailscale.com only.' };
    try {
      const bundle = await this.command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${APP}/Contents/Info.plist`]);
      if (bundle.trim() !== 'io.tailscale.ipn.macsys') throw new Error('The installed app is not the standalone Tailscale variant.');
      await this.command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB"', APP]);
      await this.command('/usr/bin/sudo', ['-n', '-l', '--', CLI, 'down-for-update']);
      return { canRestart: true };
    } catch (error) {
      return { canRestart: false, reason: `${String(error)} Restart requires this OS user to have noninteractive administrator permission for the app’s down-for-update command. No permissions were changed.` };
    }
  }

  async restart(): Promise<{ restarted: boolean; vpnReady: boolean; recoveryAttempted: boolean; errors: string[] }> {
    const preflight = await this.check();
    if (!preflight.canRestart) throw new Error(preflight.reason);
    const errors: string[] = [];
    let stopped = false;
    try {
      await this.command('/usr/bin/sudo', ['-n', '--', CLI, 'down-for-update']);
      stopped = true;
    } catch (error) { errors.push(String(error)); }
    // Always attempt restoration after a stop attempt, including timeout or
    // ambiguous failure. Never stop again as part of recovery.
    let started = false;
    for (let attempt = 0; attempt < 2 && !started; attempt++) {
      try {
        await this.command(CLI, ['rungui']);
        await this.command(CLI, ['up']);
        started = true;
      } catch (error) { errors.push(String(error)); }
    }
    let vpnReady = false;
    if (started) {
      try {
        const status = JSON.parse(await this.command(CLI, ['status', '--json'])) as { BackendState?: string };
        vpnReady = status.BackendState === 'Running';
      } catch (error) { errors.push(String(error)); }
    }
    return { restarted: stopped && started, vpnReady, recoveryAttempted: true, errors };
  }
}
