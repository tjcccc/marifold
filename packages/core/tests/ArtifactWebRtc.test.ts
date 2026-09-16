import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localStun } from './helpers/LocalStun';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { ArtifactWebRtc } from '../src/workspace/ArtifactWebRtc';
import { listRunArtifacts } from '../src/agent/RunArtifacts';

const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function pair(timeoutMs = 5000) {
  const stun = await localStun();
  resources.push(stun.close);
  const config = { enabled: true, timeoutMs, stunUrl: stun.url,
    peerConfig: { iceUseIpv4: true, iceUseIpv6: false, iceInterfaceAddresses: { udp4: '127.0.0.1' }, iceAdditionalHostAddresses: ['127.0.0.1'] } };
  const source = new ArtifactWebRtc(config);
  const receiver = new ArtifactWebRtc(config);
  resources.push(() => source.close(), () => receiver.close());
  return { source, receiver };
}
function fixture(size: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-webrtc-test-'));
  resources.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = randomBytes(size);
  const file = path.join(dir, 'original.bin'); fs.writeFileSync(file, bytes);
  return { bytes, artifact: { ...listRunArtifacts({ outputDir: dir })[0], path: file } };
}
it('transfers a 6 MB file directly, verifies bytes, and removes temporary storage', async () => {
  const { source, receiver } = await pair();
  const { artifact, bytes } = fixture(6_000_017);
  let offers = 0;
  const stream = await receiver.receive(bytes.length, offer => { offers++; return source.offerFile(artifact, offer, 'home'); }, 'home');
  const file = (stream as fs.ReadStream).path;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(offers).toBe(1);
  expect(fs.existsSync(file)).toBe(false);
}, 15000);
it('bounds negotiation and cancels pending downloads on workspace removal', async () => {
  const { receiver } = await pair(1000);
  await expect(receiver.receive(1, () => new Promise(() => {}), 'home')).rejects.toThrow('interrupted');
  const pending = receiver.receive(1, async () => { receiver.cancelWorkspace('home'); return {}; }, 'home');
  await expect(pending).rejects.toThrow('interrupted');
}, 10000);
it('fails closed when disabled and rejects unsupported sizes and descriptions', async () => {
  const receiver = new ArtifactWebRtc({ enabled: false });
  await expect(receiver.receive(1, async () => ({}), 'home')).rejects.toThrow('unavailable');
  await expect(receiver.receive(65 * 1024 * 1024, async () => ({}), 'home')).rejects.toThrow('limit');
  const { artifact } = fixture(10);
  await expect(receiver.offerFile(artifact, { type: 'offer', sdp: 'bad' }, 'home')).rejects.toThrow('description');
});

it('discards a transfer if its source changes after negotiation', async () => {
  const { source, receiver } = await pair(1500);
  const { artifact, bytes } = fixture(1_000_000);
  await expect(receiver.receive(bytes.length, async offer => {
    const answer = await source.offerFile(artifact, offer, 'home');
    fs.truncateSync(artifact.path, 10);
    return answer;
  }, 'home')).rejects.toThrow('interrupted');
}, 10000);
