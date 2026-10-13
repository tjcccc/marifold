import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DockerCli } from './DockerCli';
import { proxyDispatcher } from '../util/proxy';

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 * 1024;

interface ImageReference {
  registry: string;
  repository: string;
  reference: string;
  /** Normalized name Docker tags the loaded image with, e.g. docker.io/library/ubuntu:24.04. */
  name: string;
}

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os?: string; architecture?: string; variant?: string };
}

/** Split an image name the way Docker does (Docker Hub by default, `library/` for official images). */
export function parseImageReference(image: string): ImageReference {
  const [, rest = image, digest] = /^(.*?)(?:@(sha256:[a-f0-9]{64}))?$/.exec(image) ?? [];
  const slash = rest.indexOf('/');
  const first = slash < 0 ? '' : rest.slice(0, slash);
  const explicitRegistry = first !== '' && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registryName = explicitRegistry ? first : 'docker.io';
  let repository = explicitRegistry ? rest.slice(slash + 1) : rest;
  let tag = 'latest';
  const colon = repository.lastIndexOf(':');
  if (colon > repository.lastIndexOf('/')) {
    tag = repository.slice(colon + 1);
    repository = repository.slice(0, colon);
  }
  if (registryName === 'docker.io' && !repository.includes('/')) { repository = `library/${repository}`; }
  const reference = digest ?? tag;
  return {
    registry: registryName === 'docker.io' ? 'registry-1.docker.io' : registryName,
    repository,
    reference,
    name: `${registryName}/${repository}${digest ? `@${digest}` : `:${tag}`}`,
  };
}

/**
 * Download an image from its registry through `proxy` (an HTTP proxy on this
 * device) and load it into Docker. Used when Docker's own downloads cannot
 * reach the registry. Every blob is checked against its digest.
 */
export async function downloadImageThroughProxy(docker: DockerCli, image: string, platform: string, proxy: string, signal?: AbortSignal): Promise<void> {
  const ref = parseImageReference(image);
  const dispatcher = proxyDispatcher(proxy);
  let token: string | undefined;
  const request = async (url: string, accept: string[]): Promise<Response> => {
    const send = () => fetch(url, {
      headers: { accept: accept.join(', '), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      // @ts-expect-error undici's dispatcher option is not in the DOM fetch types.
      dispatcher,
      signal: signal ?? AbortSignal.timeout(30 * 60_000),
    });
    let response = await send();
    if (response.status === 401 && !token) {
      token = await bearerToken(response.headers.get('www-authenticate') ?? '', dispatcher);
      response = await send();
    }
    if (!response.ok) { throw new Error(`${url} answered ${response.status} ${response.statusText}`); }
    return response;
  };
  const base = `https://${ref.registry}/v2/${ref.repository}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-image-'));
  try {
    const blobs = path.join(dir, 'blobs', 'sha256');
    fs.mkdirSync(blobs, { recursive: true });
    const save = (digest: string, body: Buffer) => {
      checkDigest(digest, body);
      fs.writeFileSync(path.join(blobs, digest.slice('sha256:'.length)), body);
    };

    let response = await request(`${base}/manifests/${ref.reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
    let body = Buffer.from(await response.arrayBuffer());
    let manifest: Descriptor = { mediaType: mediaTypeOf(response, body), digest: `sha256:${sha256(body)}`, size: body.length };
    if (INDEX_TYPES.includes(manifest.mediaType)) {
      const chosen = choosePlatform((JSON.parse(body.toString('utf8')) as { manifests?: Descriptor[] }).manifests ?? [], platform);
      if (!chosen) { throw new Error(`${image} has no ${platform} variant.`); }
      response = await request(`${base}/manifests/${chosen.digest}`, MANIFEST_TYPES);
      body = Buffer.from(await response.arrayBuffer());
      manifest = { mediaType: mediaTypeOf(response, body), digest: chosen.digest, size: body.length };
    }
    save(manifest.digest, body);
    const parsed = JSON.parse(body.toString('utf8')) as { config: Descriptor; layers: Descriptor[] };
    let total = 0;
    for (const blob of [parsed.config, ...parsed.layers]) {
      total += blob.size;
      if (total > MAX_IMAGE_BYTES) { throw new Error(`${image} is larger than ${MAX_IMAGE_BYTES / 1024 ** 3} GB.`); }
      const data = Buffer.from(await (await request(`${base}/blobs/${blob.digest}`, ['*/*'])).arrayBuffer());
      save(blob.digest, data);
    }

    // An OCI image layout; Docker tags it from the containerd name annotation.
    fs.writeFileSync(path.join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      schemaVersion: 2,
      manifests: [{
        mediaType: manifest.mediaType, digest: manifest.digest, size: manifest.size,
        annotations: { 'io.containerd.image.name': ref.name, 'org.opencontainers.image.ref.name': ref.reference },
      }],
    }));
    const tar = spawn('tar', ['-C', dir, '-cf', '-', 'oci-layout', 'index.json', 'blobs'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const loaded = await docker.run(['load'], { input: tar.stdout, timeoutMs: 30 * 60_000 });
    if (loaded.code !== 0) { throw new Error(`docker load failed: ${loaded.stderr.trim()}`); }
    // Older Docker versions load the image untagged; tag it so the build finds it.
    if ((await docker.run(['image', 'inspect', image])).code !== 0) {
      const id = /Loaded image ID: (sha256:[a-f0-9]+)/.exec(loaded.stdout.toString('utf8'))?.[1];
      if (!id || (await docker.run(['tag', id, image])).code !== 0) { throw new Error(`Docker loaded ${image} but did not tag it.`); }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function bearerToken(challenge: string, dispatcher: ReturnType<typeof proxyDispatcher>): Promise<string> {
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  if (!/^bearer /i.test(challenge) || !params.realm?.startsWith('https://')) { throw new Error('The registry asked for credentials marifold does not have.'); }
  const url = new URL(params.realm);
  for (const key of ['service', 'scope']) {
    if (params[key]) { url.searchParams.set(key, params[key]); }
  }
  // @ts-expect-error undici's dispatcher option is not in the DOM fetch types.
  const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) { throw new Error(`The registry token service answered ${response.status}.`); }
  const value = (await response.json()) as { token?: string; access_token?: string };
  const token = value.token ?? value.access_token;
  if (!token) { throw new Error('The registry token service returned no token.'); }
  return token;
}

export function choosePlatform(manifests: Descriptor[], platform: string): Descriptor | undefined {
  const [osName, architecture, variant] = platform.split('/');
  const candidates = manifests.filter(item => item.platform?.os === osName && item.platform?.architecture === architecture);
  return candidates.find(item => !variant || item.platform?.variant === variant)
    ?? candidates.find(item => architecture === 'arm64' && (item.platform?.variant ?? 'v8') === 'v8')
    ?? candidates[0];
}

function mediaTypeOf(response: Response, body: Buffer): string {
  const declared = (JSON.parse(body.toString('utf8')) as { mediaType?: string }).mediaType;
  return declared ?? response.headers.get('content-type')?.split(';')[0]?.trim() ?? MANIFEST_TYPES[0];
}

function checkDigest(digest: string, body: Buffer): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || `sha256:${sha256(body)}` !== digest) {
    throw new Error(`Downloaded data does not match ${digest}.`);
  }
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
