import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { BRIDGE_DEPLOYMENT_FILE, BRIDGE_TOKEN_FILE, cloudflareBridgeDirectory } from '@marifold/core';
import type { ConsolePrinter } from '../output/ConsolePrinter';

// Pinned so every deploy uploads with a tested wrangler; bump it deliberately.
const WRANGLER = 'wrangler@4.151.3';
function workerConfig(name: string) {
  return {
    name,
    main: 'worker.js',
    no_bundle: true,
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    durable_objects: { bindings: [{ name: 'BRIDGE', class_name: 'BridgeRelay' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BridgeRelay'] }],
  };
}
function deployedUrl(outputFile: string): string | undefined {
  try {
    for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
      if (!line.trim()) { continue; }
      const entry = JSON.parse(line) as { type?: string; targets?: unknown };
      const target = Array.isArray(entry.targets) ? entry.targets.find((t) => typeof t === 'string' && t.startsWith('https://')) : undefined;
      if (entry.type === 'deploy' && typeof target === 'string') { return new URL(target).origin; }
    }
  } catch {
    /* no output file: report below */
  }
  return undefined;
}
function deployCloudflare(name: string): string {
  const worker = path.join(__dirname, '..', 'bridge-cloudflare', 'worker.js');
  if (!fs.existsSync(worker)) { throw new Error('Cloudflare bridge bundle is missing. Rebuild or reinstall marifold.'); }
  const directory = cloudflareBridgeDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(worker, path.join(directory, 'worker.js'));
  fs.writeFileSync(path.join(directory, 'wrangler.json'), `${JSON.stringify(workerConfig(name), null, 2)}\n`);
  // Stops npx from treating an enclosing folder's package.json as the project.
  fs.writeFileSync(path.join(directory, 'package.json'), '{ "private": true }\n');
  const tokenFile = path.join(directory, BRIDGE_TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) { fs.writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' }); }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  // The token goes up with the deploy itself, so the Worker never runs without it.
  const secrets = path.join(directory, '.deploy-secrets.json');
  const output = path.join(directory, '.wrangler-output.ndjson');
  fs.rmSync(secrets, { force: true });
  fs.rmSync(output, { force: true });
  fs.writeFileSync(secrets, JSON.stringify({ MARIFOLD_BRIDGE_REGISTRATION_TOKEN: token }), { mode: 0o600, flag: 'wx' });
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--yes', WRANGLER, 'deploy', '--secrets-file', secrets],
      { cwd: directory, stdio: 'inherit', env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output, WRANGLER_SEND_METRICS: 'false' } },
    );
    if (result.error) { throw new Error('Could not run npx. Install Node.js with npm, then retry.'); }
    if (result.status !== 0) { throw new Error('wrangler deploy failed; see its output above. Nothing on this device was changed except the deploy files.'); }
  } finally {
    fs.rmSync(secrets, { force: true });
  }
  const url = deployedUrl(output);
  fs.rmSync(output, { force: true });
  if (!url) { throw new Error('Deployed, but wrangler did not report the Worker URL. Find it in the Cloudflare dashboard under Workers & Pages.'); }
  fs.writeFileSync(
    path.join(directory, BRIDGE_DEPLOYMENT_FILE),
    `${JSON.stringify({ provider: 'cloudflare', name, url, deployedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return url;
}

export function registerBridgeDeploy(bridge: Command, printer: ConsolePrinter): void {
  bridge
    .command('deploy <provider>')
    .description('Deploy a personal bridge to Cloudflare Workers (provider: cloudflare). Signs in to Cloudflare in the browser on first use.')
    .option('--name <worker>', 'Worker name; it becomes part of the workers.dev URL.', 'marifold-bridge')
    .action((provider: string, options: { name: string }) => {
      try {
        if (provider !== 'cloudflare') { throw new Error('Supported provider: cloudflare.'); }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.name)) {
          throw new Error('Worker name must use lowercase letters, digits and hyphens.');
        }
        const url = deployCloudflare(options.name);
        process.stdout.write(
          `\nBridge deployed: ${url}\n` +
            `Host a workspace through it: marifold workspace create <name> --bridge ${url}\n` +
            `This device saved the registration token in ${path.join(cloudflareBridgeDirectory(), BRIDGE_TOKEN_FILE)} and uses it automatically.\n` +
            'Run the same command again to update the bridge after upgrading marifold.\n',
        );
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
}
