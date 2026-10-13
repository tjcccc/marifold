import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MarifoldError } from '../errors/MarifoldError';
import { MARIFOLD_VERSION } from '../workspace/MarifoldVersion';
import { accountName, accountNameProblem, DEFAULT_PROFILE, type ComputerAccount, nextAccountUid, type PendingRemoval, RECONCILE_SCRIPT, reconcileInput } from './AgentComputerAccounts';
import { buildComputerImage, ComputerSetupError, DEFAULT_BASE_IMAGE, EGRESS_ALIAS, EGRESS_PORT } from './AgentComputerImage';
import { DockerCli, findDocker } from './DockerCli';

export interface AgentComputerSettings {
  /** The user's own HTTP proxy as seen from this device, e.g. http://127.0.0.1:7890. */
  proxy?: string;
  baseImage?: string;
}

export interface DockerEnvironment {
  available: boolean;
  runtime?: string;
  context?: string;
  serverVersion?: string;
  platform?: string;
  error?: string;
}

export interface AgentComputerInfo {
  container: string;
  state: 'running' | 'stopped' | 'missing' | 'creating' | 'failed';
  createdAt?: number;
  error?: string;
  /** Docker's own output for `error`, when there is any. */
  errorDetail?: string;
}

/** A profile's account on the computer: none, an account without access, or access. */
export interface AgentComputerProfile {
  profile: string;
  /** The Linux account: the profile name, or "marifold" for the default profile. */
  accountName: string;
  /** The default profile's account comes with the computer and always has access. */
  fixed?: true;
  account: boolean;
  access: boolean;
  /** Set when the profile name cannot be an account name. */
  problem?: string;
}

export interface AgentComputerStatus {
  docker: DockerEnvironment;
  settings: AgentComputerSettings & { upstream?: string };
  image: { tag: string; present: boolean };
  egress: { container: string; state: 'running' | 'stopped' | 'missing' };
  computer: AgentComputerInfo;
  profiles: AgentComputerProfile[];
}

/** Where a profile's commands run. */
export interface ComputerSession {
  container: string;
  user: string;
  home: string;
}

interface StoredState {
  settings: AgentComputerSettings;
  computer?: { createdAt: number };
  accounts: Record<string, ComputerAccount>;
  pendingRemovals: PendingRemoval[];
}

const LABEL = 'dev.marifold.computer';

/**
 * The agent's own computer: one Docker container on an internal network whose
 * only way out is a filtering egress proxy container. Each profile that has
 * access works in its own account there; /home lives on a named volume, so a
 * rebuild keeps the files. Marifold on this device drives it with `docker
 * exec`; no Marifold key or service runs inside. Everything it creates carries
 * labels scoped to this configuration.
 */
export class AgentComputer {
  readonly instance: string;
  private readonly stateFile: string;
  private docker?: DockerCli;
  private operation?: { state: 'creating' | 'failed'; error?: string; errorDetail?: string };
  /** Container ID + accounts last reconciled, so most commands skip it. */
  private reconciled?: string;

  constructor(configPath: string, private readonly dockerBinary?: string) {
    this.instance = createHash('sha256').update(path.resolve(configPath)).digest('hex').slice(0, 8);
    this.stateFile = path.join(path.dirname(configPath), 'agent-computer.json');
  }

  get networkName(): string { return `marifold-${this.instance}-agent-net`; }
  get egressName(): string { return `marifold-${this.instance}-egress`; }
  get containerName(): string { return `marifold-${this.instance}-computer`; }
  get volumeName(): string { return `marifold-${this.instance}-home`; }
  get imageTag(): string { return `marifold-agent-computer-${this.instance}:${MARIFOLD_VERSION}`; }

  /** True when the computer exists and this profile may use it; decides which tools a run gets. */
  has(profile: string): boolean {
    const state = this.read();
    return Boolean(state.computer && state.accounts[profile]?.access);
  }

  settings(): AgentComputerSettings {
    return this.read().settings;
  }

  /** A field left out keeps its value; an empty string clears it. */
  async updateSettings(next: AgentComputerSettings): Promise<AgentComputerSettings> {
    const current = this.read().settings;
    const proxy = next.proxy === undefined ? current.proxy : next.proxy.trim() || undefined;
    const baseImage = next.baseImage === undefined ? current.baseImage : next.baseImage.trim() || undefined;
    if (proxy) { upstreamFor(proxy); }
    if (baseImage && !/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i.test(baseImage)) { throw MarifoldError.configInvalid('Invalid base image name.'); }
    const settings: AgentComputerSettings = { ...(proxy ? { proxy } : {}), ...(baseImage ? { baseImage } : {}) };
    this.write({ ...this.read(), settings });
    // A running egress container picks up a new proxy only when recreated.
    if (this.read().computer && (await this.dockerEnvironment()).available) {
      await this.cli().run(['rm', '-f', this.egressName]);
      await this.ensureEgress();
    }
    return settings;
  }

  async dockerEnvironment(): Promise<DockerEnvironment> {
    const binary = this.dockerBinary ?? findDocker();
    if (!binary) { return { available: false, error: 'Docker is not installed. Install OrbStack, Docker Desktop, or Colima.' }; }
    this.docker ??= new DockerCli(binary);
    const version = await this.docker.run(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], { timeoutMs: 15_000 }).catch((error: Error) => ({ code: 1, stdout: Buffer.alloc(0), stderr: error.message }));
    if (version.code !== 0) { return { available: false, error: `Docker is installed but not running: ${version.stderr.trim().split('\n').pop()}` }; }
    const [serverVersion, platform] = version.stdout.toString('utf8').trim().split(' ');
    const context = (await this.docker.run(['context', 'show'], { timeoutMs: 10_000 })).stdout.toString('utf8').trim();
    const system = (await this.docker.run(['info', '--format', '{{.OperatingSystem}} {{.Name}}'], { timeoutMs: 15_000 })).stdout.toString('utf8');
    const seen = `${context} ${system}`;
    const runtime = /orbstack/i.test(seen) ? 'OrbStack' : /docker desktop/i.test(seen) ? 'Docker Desktop' : /colima/i.test(seen) ? 'Colima' : 'Docker';
    return { available: true, runtime, context, serverVersion, platform };
  }

  async status(profiles: string[]): Promise<AgentComputerStatus> {
    const docker = await this.dockerEnvironment();
    const state = this.read();
    const settings = { ...state.settings, ...(state.settings.proxy ? { upstream: upstreamFor(state.settings.proxy) } : {}) };
    const containers = docker.available ? await this.containers() : new Map<string, string>();
    const image = docker.available && (await this.cli().run(['image', 'inspect', this.imageTag], { timeoutMs: 15_000 })).code === 0;
    return {
      docker,
      settings,
      image: { tag: this.imageTag, present: image },
      egress: { container: this.egressName, state: containerState(containers.get(this.egressName)) },
      computer: {
        container: this.containerName,
        state: this.operation?.state ?? (state.computer ? containerState(containers.get(this.containerName)) : 'missing'),
        ...(state.computer ? { createdAt: state.computer.createdAt } : {}),
        ...(this.operation?.error ? { error: this.operation.error } : {}),
        ...(this.operation?.errorDetail ? { errorDetail: this.operation.errorDetail } : {}),
      },
      profiles: [...profiles].sort((a, b) => Number(b === DEFAULT_PROFILE) - Number(a === DEFAULT_PROFILE)).map((profile) => {
        const account = state.accounts[profile];
        const problem = account ? undefined : accountNameProblem(profile);
        return {
          profile,
          accountName: accountName(profile),
          account: Boolean(account),
          access: account?.access === true,
          ...(profile === DEFAULT_PROFILE ? { fixed: true } : {}),
          ...(problem ? { problem } : {}),
        };
      }),
    };
  }

  /** Start creating (or, with rebuildImage, rebuilding) the computer; progress
   * shows in `status`. Accounts and their files in /home are kept. */
  create(options: { rebuildImage?: boolean } = {}): Promise<void> {
    if (this.operation?.state === 'creating') { throw MarifoldError.configInvalid('The agent computer is already being created.'); }
    this.operation = { state: 'creating' };
    const job = (async () => {
      const docker = await this.dockerEnvironment();
      if (!docker.available) { throw new Error(docker.error); }
      await this.ensureImage(options.rebuildImage === true);
      await this.ensureNetwork();
      await this.ensureEgress();
      if ((await this.cli().run(['volume', 'inspect', this.volumeName])).code !== 0) {
        await this.cli().check(['volume', 'create', ...this.labels('home'), this.volumeName]);
      }
      // Also clears per-profile computers from before 0.90.
      const old = (await this.cli().check(['ps', '-aq', '--filter', `label=${LABEL}.instance=${this.instance}`, '--filter', `label=${LABEL}.role=computer`])).split('\n').filter(Boolean);
      await this.cli().run(['rm', '-f', this.containerName, ...old], { timeoutMs: 60_000 });
      await this.cli().check([
        'run', '-d', '--name', this.containerName, '--hostname', 'agent-computer',
        '--network', this.networkName, '--init', '--restart', 'unless-stopped',
        '--memory', '4g', '--cpus', '2', '--pids-limit', '2048',
        '-v', `${this.volumeName}:/home`,
        ...this.labels('computer'), this.imageTag, 'sleep', 'infinity',
      ], { timeoutMs: 120_000 });
      const state = this.read();
      const accounts = state.accounts[DEFAULT_PROFILE]
        ? state.accounts
        : { ...state.accounts, [DEFAULT_PROFILE]: { uid: nextAccountUid(state.accounts, state.pendingRemovals), access: true, createdAt: Date.now() } };
      this.write({ ...state, computer: { createdAt: Date.now() }, accounts });
      this.reconciled = undefined;
      await this.reconcile(await this.startComputer());
      this.operation = undefined;
    })();
    job.catch((error: Error) => {
      this.operation = { state: 'failed', error: error.message, ...(error instanceof ComputerSetupError && error.detail ? { errorDetail: error.detail } : {}) };
    });
    return job;
  }

  /** Remove the computer with every account and file in it. The image stays
   * for a quick re-create; removeAll deletes that too. */
  async remove(): Promise<void> {
    this.write({ settings: this.read().settings, accounts: {}, pendingRemovals: [] });
    this.operation = undefined;
    this.reconciled = undefined;
    if (!(await this.dockerEnvironment()).available) { return; }
    await this.cli().run(['rm', '-f', this.containerName, this.egressName], { timeoutMs: 60_000 });
    await this.cli().run(['volume', 'rm', this.volumeName], { timeoutMs: 60_000 });
    await this.cli().run(['network', 'rm', this.networkName], { timeoutMs: 60_000 });
  }

  /** Remove every container, the volume, the network, and the images this configuration created. */
  async removeAll(): Promise<void> {
    await this.remove();
    if (!(await this.dockerEnvironment()).available) { return; }
    const ids = (await this.cli().check(['ps', '-aq', '--filter', `label=${LABEL}.instance=${this.instance}`])).split('\n').filter(Boolean);
    if (ids.length > 0) { await this.cli().run(['rm', '-f', ...ids], { timeoutMs: 120_000 }); }
    const images = (await this.cli().check(['images', '-q', '--filter', `reference=marifold-agent-computer-${this.instance}:*`])).split('\n').filter(Boolean);
    if (images.length > 0) { await this.cli().run(['image', 'rm', '-f', ...new Set(images)], { timeoutMs: 120_000 }); }
  }

  /** Let a profile use the computer, creating its account (and home folder) when it has none. */
  async giveAccess(profile: string): Promise<void> {
    const state = this.read();
    if (!state.computer) { throw MarifoldError.configInvalid('Create the agent computer first.'); }
    const existing = state.accounts[profile];
    if (!existing) {
      const problem = accountNameProblem(profile);
      if (problem) { throw MarifoldError.configInvalid(problem); }
    }
    const account = existing ?? { uid: nextAccountUid(state.accounts, state.pendingRemovals), access: true, createdAt: Date.now() };
    this.write({ ...state, accounts: { ...state.accounts, [profile]: { ...account, access: true } } });
    try {
      await this.ready(profile);
    } catch (error) {
      if (!existing) {
        const latest = this.read();
        delete latest.accounts[profile];
        this.write(latest);
      }
      throw error;
    }
  }

  /** Stop a profile from using the computer; its account and files stay. */
  removeAccess(profile: string): void {
    assertNotDefault(profile);
    const state = this.read();
    const account = state.accounts[profile];
    if (account) { this.write({ ...state, accounts: { ...state.accounts, [profile]: { ...account, access: false } } }); }
  }

  /** Delete a profile's account and home folder; also used when the profile is
   * deleted. If the computer is unreachable now, it happens on its next use. */
  async removeAccount(profile: string): Promise<void> {
    assertNotDefault(profile);
    const state = this.read();
    const account = state.accounts[profile];
    if (!account) { return; }
    delete state.accounts[profile];
    this.write({ ...state, pendingRemovals: [...state.pendingRemovals, { uid: account.uid, name: accountName(profile) }] });
    await this.applyNow();
  }

  /** Keep a renamed profile's account: same UID, new name and home folder. */
  async renameAccount(from: string, to: string): Promise<void> {
    const state = this.read();
    const account = state.accounts[from];
    if (!account || from === to || from === DEFAULT_PROFILE || to === DEFAULT_PROFILE) { return; }
    delete state.accounts[from];
    this.write({ ...state, accounts: { ...state.accounts, [to]: account } });
    await this.applyNow();
  }

  /** Make sure the computer, its egress, and the profile's account are ready before use. */
  async ready(profile: string): Promise<ComputerSession> {
    const state = this.read();
    if (!state.computer) { throw new Error('There is no agent computer. Create it in Settings → Agent computer.'); }
    if (!state.accounts[profile]?.access) { throw new Error(`The ${profile} profile has no access to the agent computer. Give it access in Settings → Agent computer.`); }
    // After an upgrade the current image may not exist yet (built once, then fast).
    await this.ensureImage(false);
    await this.ensureEgress();
    await this.reconcile(await this.startComputer());
    const user = accountName(profile);
    return { container: this.containerName, user, home: `/home/${user}` };
  }

  cli(): DockerCli {
    if (!this.docker) {
      const binary = this.dockerBinary ?? findDocker();
      if (!binary) { throw new Error('Docker is not installed.'); }
      this.docker = new DockerCli(binary);
    }
    return this.docker;
  }

  /** Start the computer if needed; returns its container ID. */
  private async startComputer(): Promise<string> {
    const inspect = await this.cli().run(['inspect', '--format', '{{.Id}} {{.State.Running}}', this.containerName], { timeoutMs: 30_000 });
    if (inspect.code !== 0) { throw new Error('The agent computer is missing. Re-create it in Settings → Agent computer.'); }
    const [id, running] = inspect.stdout.toString('utf8').trim().split(' ');
    if (running !== 'true') {
      const started = await this.cli().run(['start', this.containerName], { timeoutMs: 60_000 });
      if (started.code !== 0) { throw new Error(`The agent computer did not start: ${started.stderr.trim()}`); }
    }
    return id ?? '';
  }

  /** Bring the accounts in the computer in line with the stored ones. */
  private async reconcile(containerId: string): Promise<void> {
    const state = this.read();
    const input = reconcileInput(state.accounts, state.pendingRemovals);
    const key = `${containerId}\n${input}`;
    if (this.reconciled === key) { return; }
    await this.cli().check(['exec', '-i', '-u', 'root', this.containerName, 'bash', '-c', RECONCILE_SCRIPT], { input, timeoutMs: 120_000 });
    const done = new Set(state.pendingRemovals.map(item => item.uid));
    const latest = this.read();
    const after = { ...latest, pendingRemovals: latest.pendingRemovals.filter(item => !done.has(item.uid)) };
    this.write(after);
    this.reconciled = `${containerId}\n${reconcileInput(after.accounts, after.pendingRemovals)}`;
  }

  /** Apply account changes now when the computer is reachable; otherwise on its next use. */
  private async applyNow(): Promise<void> {
    if (!this.read().computer || !(await this.dockerEnvironment()).available) { return; }
    try {
      await this.reconcile(await this.startComputer());
    } catch {
      // Kept in the state file and retried by the next ready().
    }
  }

  private async ensureImage(rebuild: boolean): Promise<void> {
    if (!rebuild && (await this.cli().run(['image', 'inspect', this.imageTag])).code === 0) { return; }
    const settings = this.settings();
    const docker = await this.dockerEnvironment();
    await buildComputerImage(this.cli(), this.imageTag, {
      baseImage: settings.baseImage ?? DEFAULT_BASE_IMAGE,
      pullHelp: pullHelp(docker.runtime, settings.proxy),
      ...(settings.proxy && docker.platform ? { downloadProxy: settings.proxy, platform: docker.platform } : {}),
      ...(settings.proxy ? { buildProxy: `http://${upstreamFor(settings.proxy)}` } : {}),
    });
  }

  private async ensureNetwork(): Promise<void> {
    if ((await this.cli().run(['network', 'inspect', this.networkName])).code === 0) { return; }
    // --internal: no route out of this network except through the egress container.
    await this.cli().check(['network', 'create', '--internal', ...this.labels('network'), this.networkName]);
  }

  private async ensureEgress(): Promise<void> {
    // The egress proxy is the security boundary: after an upgrade, replace it
    // rather than keep running an older proxy.
    const inspect = await this.cli().run(['inspect', '--format', '{{.Config.Image}} {{.State.Running}}', this.egressName]);
    const [image, running] = inspect.stdout.toString().trim().split(' ');
    if (inspect.code === 0 && image === this.imageTag) {
      if (running !== 'true') { await this.cli().check(['start', this.egressName]); }
      return;
    }
    if (inspect.code === 0) { await this.cli().run(['rm', '-f', this.egressName]); }
    const proxy = this.settings().proxy;
    await this.cli().check([
      'run', '-d', '--name', this.egressName, '--restart', 'unless-stopped', '--user', 'nobody',
      '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', '--memory', '256m', '--pids-limit', '256',
      '-e', `EGRESS_PORT=${EGRESS_PORT}`, ...(proxy ? ['-e', `EGRESS_UPSTREAM=${upstreamFor(proxy)}`] : []),
      ...this.labels('egress'), this.imageTag, 'node', '/opt/marifold-egress/EgressProxy.js',
    ], { timeoutMs: 120_000 });
    await this.cli().check(['network', 'connect', '--alias', EGRESS_ALIAS, this.networkName, this.egressName]);
  }

  private labels(role: string): string[] {
    return ['--label', `${LABEL}=1`, '--label', `${LABEL}.instance=${this.instance}`, '--label', `${LABEL}.role=${role}`];
  }

  private async containers(): Promise<Map<string, string>> {
    const out = await this.cli().check(['ps', '-a', '--filter', `label=${LABEL}.instance=${this.instance}`, '--format', '{{.Names}}\t{{.State}}']);
    return new Map(out.split('\n').filter(Boolean).map(line => line.split('\t') as [string, string]));
  }

  private read(): StoredState {
    try {
      // Per-profile computers from before 0.90 (`computers`) are dropped.
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<StoredState>;
      return {
        settings: value.settings ?? {},
        ...(value.computer ? { computer: value.computer } : {}),
        accounts: value.accounts ?? {},
        pendingRemovals: value.pendingRemovals ?? [],
      };
    } catch {
      return { settings: {}, accounts: {}, pendingRemovals: [] };
    }
  }

  private write(state: StoredState): void {
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.stateFile);
  }
}

/** How to give the detected Docker runtime a proxy for downloading images. */
function pullHelp(runtime: string | undefined, proxy: string | undefined): string {
  const example = proxy ?? 'http://127.0.0.1:7890';
  if (runtime === 'OrbStack') { return `OrbStack can also use it for its own downloads: orb config set network_proxy ${example}`; }
  if (runtime === 'Docker Desktop') { return `Docker Desktop can also use it for its own downloads: Settings → Resources → Proxies`; }
  return 'The Docker daemon can also be given a proxy in its own settings';
}

function assertNotDefault(profile: string): void {
  if (profile === DEFAULT_PROFILE) { throw MarifoldError.configInvalid('The default profile is the agent itself; it always keeps its marifold account.'); }
}

function containerState(state: string | undefined): 'running' | 'stopped' | 'missing' {
  return state === 'running' ? 'running' : state ? 'stopped' : 'missing';
}

/**
 * The user's proxy as the egress container reaches it: loopback on this device
 * becomes host.docker.internal (OrbStack and Docker Desktop forward it to the
 * Mac's loopback; on Linux, --add-host maps it to the host gateway).
 */
export function upstreamFor(proxy: string): string {
  let url: URL;
  try {
    url = new URL(proxy.trim());
  } catch {
    throw MarifoldError.configInvalid('The proxy must look like http://127.0.0.1:7890.');
  }
  if (url.protocol !== 'http:' || !url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw MarifoldError.configInvalid('The proxy must look like http://127.0.0.1:7890 (HTTP, with a port, no credentials).');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  return `${loopback ? 'host.docker.internal' : url.hostname}:${url.port}`;
}
