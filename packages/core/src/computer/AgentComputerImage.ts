import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENTS_GROUP } from './AgentComputerAccounts';
import type { DockerCli } from './DockerCli';
import { downloadImageThroughProxy } from './ImageDownload';

export const DEFAULT_BASE_IMAGE = 'ubuntu:24.04';
/** The egress container's name on the computers' internal network. */
export const EGRESS_ALIAS = 'marifold-egress';
export const EGRESS_PORT = 8080;

const PROXY_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
const PROXY_VARS = 'http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY';

/** The computer image: Ubuntu, passwordless sudo for the profile accounts'
 * group, a common toolchain, and the egress proxy (run by the separate egress
 * container). The accounts themselves are created at run time. */
export function dockerfile(): string {
  return `ARG BASE_IMAGE=${DEFAULT_BASE_IMAGE}
FROM \${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN mkdir -p /tmp && chmod 1777 /tmp \\
 && apt-get update \\
 && apt-get install -y --no-install-recommends sudo ca-certificates curl wget git openssh-client python3 python3-venv python3-pip pipx \\
      build-essential nodejs npm procps less nano unzip zip xz-utils jq file \\
 && rm -rf /var/lib/apt/lists/*
RUN groupadd ${AGENTS_GROUP} \\
 && printf '%%${AGENTS_GROUP} ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/90-marifold-agent \\
 && printf 'Defaults env_keep += "${PROXY_VARS}"\\n' > /etc/sudoers.d/91-marifold-proxy \\
 && chmod 0440 /etc/sudoers.d/90-marifold-agent /etc/sudoers.d/91-marifold-proxy \\
 && printf 'Acquire::http::Proxy "${PROXY_URL}";\\nAcquire::https::Proxy "${PROXY_URL}";\\n' > /etc/apt/apt.conf.d/90-marifold-proxy
COPY egress/ /opt/marifold-egress/
ENV HTTP_PROXY=${PROXY_URL} HTTPS_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} https_proxy=${PROXY_URL} \\
    NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
WORKDIR /home
`;
}

export interface BuildOptions {
  baseImage: string;
  /** Proxy URL reachable from a build container, for apt during the build. */
  buildProxy?: string;
  /** How to give this Docker runtime a proxy, shown when the base image download fails. */
  pullHelp?: string;
  /** The user's proxy on this device: the base image is downloaded through it
   * when Docker's own download cannot reach the registry. */
  downloadProxy?: string;
  /** Docker's platform, e.g. linux/arm64. */
  platform?: string;
  onOutput?: (text: string) => void;
}

/** A setup failure with a plain explanation (`message`) and Docker's own output (`detail`). */
export class ComputerSetupError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

/** Stage the build context (Dockerfile + compiled egress proxy) and build. */
export async function buildComputerImage(docker: DockerCli, tag: string, options: BuildOptions): Promise<void> {
  // Docker downloads the base image itself, through its own network settings
  // (not the proxy setting, which reaches only commands inside the build), so
  // fetch it as its own step and say so when it fails.
  if ((await docker.run(['image', 'inspect', options.baseImage], { timeoutMs: 30_000 })).code !== 0) {
    const pulled = await docker.run(['pull', options.baseImage], { timeoutMs: 30 * 60_000 });
    if (pulled.code !== 0) {
      const output = `${pulled.stdout.toString('utf8')}\n${pulled.stderr}`.trim();
      if (options.downloadProxy && options.platform) {
        try {
          await downloadImageThroughProxy(docker, options.baseImage, options.platform, options.downloadProxy);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new ComputerSetupError(
            `Could not download the base image ${options.baseImage}, neither through Docker${shortReason(output)} nor through the proxy ${options.downloadProxy} (${reason}). Check that the proxy is running, or set a mirror base image, then try again.`,
            `${output}\n\nThrough ${options.downloadProxy}: ${reason}`,
          );
        }
      } else {
        throw new ComputerSetupError(
          `Docker could not download the base image ${options.baseImage}${shortReason(output)}. Set the proxy you use on this device above and try again, or set a mirror base image. (${options.pullHelp ?? 'Docker can also be given a proxy in its own settings'}.)`,
          output,
        );
      }
    }
  }
  const egressDir = __dirname;
  for (const file of ['EgressFilter.js', 'EgressProxy.js']) {
    if (!fs.existsSync(path.join(egressDir, file))) { throw new Error(`Missing ${file}; build Marifold before creating the agent computer.`); }
  }
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-computer-build-'));
  try {
    fs.mkdirSync(path.join(context, 'egress'));
    for (const file of ['EgressFilter.js', 'EgressProxy.js']) {
      fs.copyFileSync(path.join(egressDir, file), path.join(context, 'egress', file));
    }
    fs.writeFileSync(path.join(context, 'Dockerfile'), dockerfile());
    const proxyArgs = options.buildProxy
      ? ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].flatMap(name => ['--build-arg', `${name}=${options.buildProxy}`])
      : [];
    const result = await docker.run([
      // No --progress: hosts without buildx use the legacy builder, which rejects it.
      'build', '--add-host', 'host.docker.internal:host-gateway',
      '--build-arg', `BASE_IMAGE=${options.baseImage}`, ...proxyArgs,
      '--label', 'dev.marifold.computer=1', '-t', tag, context,
    ], { timeoutMs: 30 * 60_000 });
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`;
    options.onOutput?.(output);
    if (result.code !== 0) {
      throw new ComputerSetupError(
        `Building the agent computer image failed${shortReason(output)}. If this device needs a proxy to reach the internet, set it above and try again.`,
        lastLines(output, 40),
      );
    }
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

/** The last error clause of Docker output, such as ": Bad Gateway". */
function shortReason(output: string): string {
  const line = output.split('\n').map(text => text.trim()).filter(Boolean).at(-1) ?? '';
  const reason = line.split(': ').at(-1)?.trim() ?? '';
  return reason && reason.length <= 80 ? ` (${reason})` : '';
}

export function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n');
}
