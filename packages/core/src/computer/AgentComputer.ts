import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MarifoldError } from '../errors/MarifoldError';
import { MARIFOLD_VERSION } from '../workspace/MarifoldVersion';
import { buildComputerImage, COMPUTER_USER, DEFAULT_BASE_IMAGE, EGRESS_ALIAS, EGRESS_PORT } from './AgentComputerImage';
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
  profile: string;
  container: string;
  state: 'running' | 'stopped' | 'missing' | 'creating' | 'failed';
  createdAt?: number;
  error?: string;
}

export interface AgentComputerStatus {
  docker: DockerEnvironment;
  settings: AgentComputerSettings & { upstream?: string };
  image: { tag: string; present: boolean };
  egress: { container: string; state: 'running' | 'stopped' | 'missing' };
  computers: AgentComputerInfo[];
}

interface StoredState {
  settings: AgentComputerSettings;
  computers: Record<string, { createdAt: number }>;
}

const LABEL = 'dev.marifold.computer';
const PROFILE_NAME = /^[a-z0-9][a-z0-9_.-]{0,40}$/;

/**
 * The agent's own computers: one Docker container per profile on an internal
 * network whose only way out is a filtering egress proxy container. Marifold on
 * this device drives them with `docker exec`; no Marifold key or service runs
 * inside. Everything it creates carries labels scoped to this configuration.
 */
export class AgentComputer {
  readonly instance: string;
  private readonly stateFile: string;
  private docker?: DockerCli;
  private readonly operations = new Map<string, { state: 'creating' | 'failed'; error?: string }>();

  constructor(configPath: string, private readonly dockerBinary?: string) {
    this.instance = createHash('sha256').update(path.resolve(configPath)).digest('hex').slice(0, 8);
    this.stateFile = path.join(path.dirname(configPath), 'agent-computer.json');
  }

  get networkName(): string { return `marifold-${this.instance}-agent-net`; }
  get egressName(): string { return `marifold-${this.instance}-egress`; }
  get imageTag(): string { return `marifold-agent-computer-${this.instance}:${MARIFOLD_VERSION}`; }
  containerName(profile: string): string { return `marifold-${this.instance}-computer-${checkedProfile(profile)}`; }

  /** True when this profile has a computer; used to decide which tools a run gets. */
  has(profile: string): boolean {
    return Boolean(this.read().computers[profile]);
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
    if (Object.keys(this.read().computers).length > 0 && (await this.dockerEnvironment()).available) {
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
    const names = [...new Set([...profiles, ...Object.keys(state.computers)])].filter(name => PROFILE_NAME.test(name));
    return {
      docker,
      settings,
      image: { tag: this.imageTag, present: image },
      egress: { container: this.egressName, state: containerState(containers.get(this.egressName)) },
      computers: names.map((profile) => {
        const container = this.containerName(profile);
        const operation = this.operations.get(profile);
        const recorded = state.computers[profile];
        return {
          profile,
          container,
          state: operation?.state ?? (recorded ? containerState(containers.get(container)) : 'missing'),
          ...(recorded ? { createdAt: recorded.createdAt } : {}),
          ...(operation?.error ? { error: operation.error } : {}),
        };
      }),
    };
  }

  /** Start creating a profile's computer; progress shows in `status`. */
  create(profile: string, options: { rebuildImage?: boolean } = {}): Promise<void> {
    checkedProfile(profile);
    if (this.operations.get(profile)?.state === 'creating') { throw MarifoldError.configInvalid(`The ${profile} computer is already being created.`); }
    this.operations.set(profile, { state: 'creating' });
    const job = (async () => {
      if (!(await this.dockerEnvironment()).available) { throw new Error((await this.dockerEnvironment()).error); }
      await this.ensureImage(options.rebuildImage === true);
      await this.ensureNetwork();
      await this.ensureEgress();
      const name = this.containerName(profile);
      await this.cli().run(['rm', '-f', name]);
      await this.cli().check([
        'run', '-d', '--name', name, '--hostname', `${profile.replace(/[^a-z0-9-]/g, '-')}-computer`,
        '--network', this.networkName, '--init', '--restart', 'unless-stopped',
        '--memory', '4g', '--cpus', '2', '--pids-limit', '2048',
        ...this.labels('computer', profile), this.imageTag, 'sleep', 'infinity',
      ], { timeoutMs: 120_000 });
      const state = this.read();
      this.write({ ...state, computers: { ...state.computers, [profile]: { createdAt: Date.now() } } });
      this.operations.delete(profile);
    })();
    job.catch((error: Error) => this.operations.set(profile, { state: 'failed', error: error.message }));
    return job;
  }

  /** Remove a profile's computer (its files are lost). The shared network and
   * egress container go with the last computer. */
  async remove(profile: string): Promise<void> {
    const state = this.read();
    delete state.computers[profile];
    this.write(state);
    this.operations.delete(profile);
    if (!(await this.dockerEnvironment()).available) { return; }
    await this.cli().run(['rm', '-f', this.containerName(profile)], { timeoutMs: 60_000 });
    if (Object.keys(state.computers).length === 0) {
      await this.cli().run(['rm', '-f', this.egressName], { timeoutMs: 60_000 });
      await this.cli().run(['network', 'rm', this.networkName], { timeoutMs: 60_000 });
    }
  }

  /** Remove every container, the network, and the image this configuration created. */
  async removeAll(): Promise<void> {
    this.write({ settings: this.read().settings, computers: {} });
    this.operations.clear();
    if (!(await this.dockerEnvironment()).available) { return; }
    const ids = (await this.cli().check(['ps', '-aq', '--filter', `label=${LABEL}.instance=${this.instance}`])).split('\n').filter(Boolean);
    if (ids.length > 0) { await this.cli().run(['rm', '-f', ...ids], { timeoutMs: 120_000 }); }
    await this.cli().run(['network', 'rm', this.networkName]);
    const images = (await this.cli().check(['images', '-q', '--filter', `reference=marifold-agent-computer-${this.instance}:*`])).split('\n').filter(Boolean);
    if (images.length > 0) { await this.cli().run(['image', 'rm', '-f', ...new Set(images)], { timeoutMs: 120_000 }); }
  }

  /** Make sure a profile's computer and its egress are running before use. */
  async ready(profile: string): Promise<string> {
    if (!this.has(profile)) { throw new Error(`The ${profile} profile has no agent computer. Create it in Settings → Agent computer.`); }
    const name = this.containerName(profile);
    // After an upgrade the current image may not exist yet (built once, then fast).
    await this.ensureImage(false);
    await this.ensureEgress();
    const started = await this.cli().run(['start', name], { timeoutMs: 60_000 });
    if (started.code !== 0) { throw new Error(`The ${profile} computer is unavailable: ${started.stderr.trim() || 'not found'}. Recreate it in Settings → Agent computer.`); }
    return name;
  }

  cli(): DockerCli {
    if (!this.docker) {
      const binary = this.dockerBinary ?? findDocker();
      if (!binary) { throw new Error('Docker is not installed.'); }
      this.docker = new DockerCli(binary);
    }
    return this.docker;
  }

  private async ensureImage(rebuild: boolean): Promise<void> {
    if (!rebuild && (await this.cli().run(['image', 'inspect', this.imageTag])).code === 0) { return; }
    const settings = this.settings();
    await buildComputerImage(this.cli(), this.imageTag, {
      baseImage: settings.baseImage ?? DEFAULT_BASE_IMAGE,
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

  private labels(role: string, profile?: string): string[] {
    return ['--label', `${LABEL}=1`, '--label', `${LABEL}.instance=${this.instance}`, '--label', `${LABEL}.role=${role}`,
      ...(profile ? ['--label', `${LABEL}.profile=${profile}`] : [])];
  }

  private async containers(): Promise<Map<string, string>> {
    const out = await this.cli().check(['ps', '-a', '--filter', `label=${LABEL}.instance=${this.instance}`, '--format', '{{.Names}}\t{{.State}}']);
    return new Map(out.split('\n').filter(Boolean).map(line => line.split('\t') as [string, string]));
  }

  private read(): StoredState {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<StoredState>;
      return { settings: value.settings ?? {}, computers: value.computers ?? {} };
    } catch {
      return { settings: {}, computers: {} };
    }
  }

  private write(state: StoredState): void {
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.stateFile);
  }
}

export { COMPUTER_USER };

function containerState(state: string | undefined): 'running' | 'stopped' | 'missing' {
  return state === 'running' ? 'running' : state ? 'stopped' : 'missing';
}

function checkedProfile(profile: string): string {
  if (!PROFILE_NAME.test(profile)) { throw MarifoldError.configInvalid(`"${profile}" cannot name an agent computer; use lowercase letters, digits, ".", "_" or "-".`); }
  return profile;
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
