import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DockerCli } from './DockerCli';

export const DEFAULT_BASE_IMAGE = 'ubuntu:24.04';
/** The egress container's name on the computers' internal network. */
export const EGRESS_ALIAS = 'marifold-egress';
export const EGRESS_PORT = 8080;
export const COMPUTER_USER = 'agent';

const PROXY_URL = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
const PROXY_VARS = 'http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY';

/** The computer image: Ubuntu, the agent account with passwordless sudo, a
 * common toolchain, and the egress proxy (run by the separate egress container). */
export function dockerfile(): string {
  return `ARG BASE_IMAGE=${DEFAULT_BASE_IMAGE}
FROM \${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN mkdir -p /tmp && chmod 1777 /tmp \\
 && apt-get update \\
 && apt-get install -y --no-install-recommends sudo ca-certificates curl wget git openssh-client python3 python3-venv python3-pip pipx \\
      build-essential nodejs npm procps less nano unzip zip xz-utils jq file \\
 && rm -rf /var/lib/apt/lists/*
RUN if ! id ${COMPUTER_USER} >/dev/null 2>&1; then useradd -m -s /bin/bash ${COMPUTER_USER}; fi \\
 && usermod -aG sudo ${COMPUTER_USER} \\
 && printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${COMPUTER_USER} > /etc/sudoers.d/90-marifold-agent \\
 && printf 'Defaults env_keep += "${PROXY_VARS}"\\n' > /etc/sudoers.d/91-marifold-proxy \\
 && chmod 0440 /etc/sudoers.d/90-marifold-agent /etc/sudoers.d/91-marifold-proxy \\
 && printf 'Acquire::http::Proxy "${PROXY_URL}";\\nAcquire::https::Proxy "${PROXY_URL}";\\n' > /etc/apt/apt.conf.d/90-marifold-proxy
COPY egress/ /opt/marifold-egress/
ENV HTTP_PROXY=${PROXY_URL} HTTPS_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} https_proxy=${PROXY_URL} \\
    NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
WORKDIR /home/${COMPUTER_USER}
`;
}

export interface BuildOptions {
  baseImage: string;
  /** Proxy URL reachable from a build container, for apt during the build. */
  buildProxy?: string;
  onOutput?: (text: string) => void;
}

/** Stage the build context (Dockerfile + compiled egress proxy) and build. */
export async function buildComputerImage(docker: DockerCli, tag: string, options: BuildOptions): Promise<void> {
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
      throw new Error(`Building the agent computer image failed: ${lastLines(output, 12)}`);
    }
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

export function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n');
}
