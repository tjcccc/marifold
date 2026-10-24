import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { createApiClient, type ApiClient } from '@marifold/client';
import { savedBridgeToken, savedBridgeUrl, type LoadedMarifoldConfig, type WorkspaceSummary } from '@marifold/core';
import { loadConfig } from './RuntimeFactory';
import { getActiveServiceProcess } from '../service/ServiceProcess';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { readSecretLine } from '../input/SecretPrompt';
import type { ConsolePrinter } from '../output/ConsolePrinter';
import { registerBridgeDeploy } from './bridgeDeploy';

export function localServiceSettings(config: LoadedMarifoldConfig): { baseUrl: string; token?: string } {
  const state = getActiveServiceProcess();
  if (!state?.address || path.resolve(state.configPath) !== path.resolve(config.configPath)) {
    throw new Error('Start this configuration’s service first: marifold service start --daemon');
  }
  const url = new URL(state.address);
  if (url.hostname === '0.0.0.0') { url.hostname = '127.0.0.1'; }
  if (url.hostname === '[::]') { url.hostname = '[::1]'; }
  const configToken = config.config.service?.token;
  const env = state.launch?.tokenEnv ?? config.config.service?.tokenEnv;
  const token = env ? process.env[env] : configToken;
  if (state.startup?.authRequired && !token) {
    throw new Error('The local service requires a token. Configure service.token_env for CLI access.');
  }
  return { baseUrl: url.origin, ...(token ? { token } : {}) };
}
export function registerWorkspaceCommand(program: Command, printer: ConsolePrinter): void {
  const group = program.command('workspace').description('Host or join a personal device-hosted workspace.');
  const bridge = group
    .command('bridge')
    .description('Deploy, prepare, install or update a personal workspace bridge.');
  registerBridgeDeploy(bridge, printer);
  for (const mode of ['install', 'update'] as const) {
    const command = bridge.command(mode).description(mode === 'install'
      ? 'Install and start a persistent bridge on this Linux server with Docker Compose.'
      : 'Update the installed Linux bridge, preserving configuration and retaining a rollback image.');
    if (mode === 'install') { command.option('--start', 'Start an existing installer-managed deployment without replacing configuration.'); }
    command.action((options: { start?: boolean }) => {
      try {
        if (process.platform !== 'linux') { throw new Error('Run this command on your Linux bridge server. Use bridge prepare to create a transferable package on this device.'); }
        const script = path.join(__dirname, '..', 'bridge-template', 'setup.sh');
        if (!fs.existsSync(script)) { throw new Error('Bridge installer is missing. Rebuild or reinstall Marifold.'); }
        const args = ['bash', script, ...(mode === 'update' ? ['--update'] : options.start ? ['--start'] : [])];
        const result = process.getuid?.() === 0
          ? spawnSync(args[0]!, args.slice(1), { stdio: 'inherit' })
          : spawnSync('sudo', args, { stdio: 'inherit' });
        if (result.error) { throw new Error('Could not launch the installer. Check that sudo and bash are installed.'); }
        process.exitCode = result.status ?? 1;
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
  }
  bridge
    .command('prepare <directory>')
    .description('Write a standalone Node bridge package for a Linux server; create no cloud resources.')
    .action((directory: string) => {
      try {
        const source = path.join(__dirname, '..', 'bridge-template');
        if (!fs.existsSync(source)) { throw new Error('Bridge template is missing. Rebuild or reinstall Marifold.'); }
        const target = path.resolve(directory);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.mkdirSync(target, { mode: 0o700 });
        fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
        process.stdout.write(
          `Prepared ${target}. Copy it to your Linux server and run sudo bash setup.sh there, or see HOSTING.md. No cloud resources were created.\n`,
        );
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    });
  const client = () => createApiClient(localServiceSettings(loadConfig(program)));
  const show = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const action =
    <Args extends unknown[]>(fn: (...args: Args) => Promise<unknown>) =>
    async (...args: Args) => {
      try {
        await fn(...args);
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      }
    };
  const resolve = async (api: ApiClient, name: string) => {
    const { workspaces } = await api.request<{ workspaces: WorkspaceSummary[] }>('GET', '/v1/workspaces');
    const matches = workspaces.filter((w) => w.id === name || w.name === name);
    if (matches.length !== 1) {
      throw new Error(matches.length ? 'Workspace name is ambiguous; use its ID.' : 'Workspace not found.');
    }
    return matches[0]!;
  };
  const secret = async (label: string) => {
    let prompt: InteractivePrompt | undefined;
    try {
      return await readSecretLine(label, () => (prompt ??= new InteractivePrompt()));
    } finally {
      prompt?.close();
    }
  };
  group
    .command('create <name>')
    .description('Share this device’s existing local workspace through a running bridge.')
    .option('--bridge <url>', 'Bridge HTTPS URL; defaults to the bridge this device deployed.')
    .option('--proxy <url>', 'Reach the bridge through this HTTP(S) proxy, e.g. http://127.0.0.1:7890 (this device only).')
    .action(
      action(async (name: string, options: { bridge?: string; proxy?: string }) => {
        const api = client();
        let bridgeUrl = options.bridge ?? savedBridgeUrl();
        if (bridgeUrl && !options.bridge) { process.stdout.write(`Using the bridge this device deployed: ${bridgeUrl}\n`); }
        if (!bridgeUrl) {
          const prompt = new InteractivePrompt();
          try {
            bridgeUrl = await prompt.readUserMessage('Bridge URL (marifold workspace bridge deploy cloudflare): ');
          } finally {
            prompt.close();
          }
        }
        if (!bridgeUrl) { throw new Error('Bridge URL is required.'); }
        const saved = savedBridgeToken(bridgeUrl);
        if (saved) { process.stdout.write('Using the registration token saved when this device deployed the bridge.\n'); }
        const registrationToken = saved ?? (await secret('Bridge registration token: '));
        const result = await api.request<{ workspace: WorkspaceSummary; invitation: string }>(
          'POST',
          '/v1/workspaces',
          { name, bridgeUrl, registrationToken, ...(options.proxy ? { proxy: options.proxy } : {}) },
        );
        show(result.workspace);
        process.stdout.write(`Single-use invitation (15 minutes):\n${result.invitation}\n`);
      }),
    );
  group
    .command('add <url>')
    .description('Pair with a workspace using a single-use invitation.')
    .option('--executor', 'Allow this host to request approval-gated agent tools on this device.')
    .option('--proxy <url>', 'Reach the bridge through this HTTP(S) proxy, e.g. http://127.0.0.1:7890 (this device only).')
    .action(
      action(async (bridgeUrl: string, options: { executor?: boolean; proxy?: string }) => {
        const api = client();
        const invitation = await secret('Workspace invitation: ');
        show(
          await api.request('POST', '/v1/workspaces/join', {
            bridgeUrl,
            invitation,
            executor: options.executor === true,
            ...(options.proxy ? { proxy: options.proxy } : {}),
          }),
        );
      }),
    );
  group
    .command('executor <nameOrId> <onOrOff>')
    .description('Enable or disable this device’s executor for a paired workspace.')
    .action(
      action(async (name: string, mode: string) => {
        if (mode !== 'on' && mode !== 'off') { throw new Error('Use on or off.'); }
        const api = client();
        const workspace = await resolve(api, name);
        show(await api.request('PUT', `/v1/workspaces/${workspace.id}/executor`, { enabled: mode === 'on' }));
      }),
    );
  group
    .command('proxy <nameOrId> <urlOrDirect>')
    .description('Reach this workspace’s bridge through an HTTP(S) proxy on this device, or "direct".')
    .action(
      action(async (name: string, value: string) => {
        const api = client();
        const w = await resolve(api, name);
        show(await api.request('PUT', `/v1/workspaces/${w.id}/proxy`, { proxy: value === 'direct' ? null : value }));
      }),
    );
  group.command('list').action(action(async () => show(await client().request('GET', '/v1/workspaces'))));
  group
    .command('remove <nameOrId>')
    .description('Disconnect a guest or stop sharing a host; preserve local data.')
    .action(
      action(async (name: string) => {
        const api = client();
        const w = await resolve(api, name);
        show(await api.request('DELETE', `/v1/workspaces/${w.id}`));
      }),
    );
  group
    .command('rename <nameOrNewName> [newName]')
    .option('--id <id>', 'Workspace ID.')
    .action(
      action(async (name: string | undefined, newName: string, options: { id?: string }) => {
        const api = client();
        const w = await resolve(api, options.id ?? name ?? '');
        const nextName = options.id ? name : newName;
        if (!nextName) { throw new Error('New workspace name is required.'); }
        show(await api.request('POST', `/v1/workspaces/${w.id}/manage/rename`, { name: nextName }));
      }),
    );
  group.command('default <nameOrId>').action(
    action(async (name: string) => {
      const api = client();
      const id = name === 'local' ? name : (await resolve(api, name)).id;
      show(await api.request('PUT', '/v1/workspaces/default', { id }));
    }),
  );
  group
    .command('invite <nameOrId>')
    .option('--executor-only', 'The new device only runs work the host sends it (for a headless machine).')
    .action(
      action(async (name: string, options: { executorOnly?: boolean }) => {
        const api = client();
        const w = await resolve(api, name);
        show(await api.request('POST', `/v1/workspaces/${w.id}/manage/invite`, options.executorOnly ? { access: 'executor' } : {}));
      }),
    );
  group.command('devices <nameOrId>').action(
    action(async (name: string) => {
      const api = client();
      const w = await resolve(api, name);
      show(await api.request('POST', `/v1/workspaces/${w.id}/manage/devices`, {}));
    }),
  );
  group.command('revoke <nameOrId> <deviceId>').action(
    action(async (name: string, deviceId: string) => {
      const api = client();
      const w = await resolve(api, name);
      show(await api.request('POST', `/v1/workspaces/${w.id}/manage/revoke`, { deviceId }));
    }),
  );
}
