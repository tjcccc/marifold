import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { RTCPeerConnection, RTCDataChannel, PeerConfig } from 'werift';
import type { ResolvedRunArtifact } from '../agent/RunArtifacts';

const MAX_FILE = 64 * 1024 * 1024;
const BLOCK = 16 * 1024;
const WINDOW = 512 * 1024;
const MAX_SESSIONS = 4;
const LABEL = 'marifold-artifact-v1';
interface Description { type: 'offer' | 'answer'; sdp: string }
interface Session { scope: string; stop: () => void }
export interface ArtifactWebRtcOptions {
  enabled?: boolean;
  stunUrl?: string;
  timeoutMs?: number;
  /** Used by isolated local transport tests, never accepted from a peer. */
  peerConfig?: Partial<PeerConfig>;
}

function description(value: unknown, type: Description['type']): Description {
  const d = value as Partial<Description> | undefined;
  if (!d || d.type !== type || typeof d.sdp !== 'string' || d.sdp.length > 64 * 1024 ||
      !d.sdp.includes('m=application ') || /^m=(audio|video) /m.test(d.sdp))
    throw new Error('Invalid artifact connection description.');
  return { type, sdp: d.sdp };
}

/** Experimental service-to-service transport. Signaling must use authenticated
 * workspace RPC. Receive into private temporary storage and verify the complete
 * file before handing it to HTTP, so any failure can safely retry via the bridge. */
export class ArtifactWebRtc {
  readonly enabled: boolean;
  private sessions = new Set<Session>();
  private closed = false;
  private activePeers = 0;
  private downloads = new Map<Readable, string>();
  private closing = new Set<Promise<void>>();
  private readonly timeout: number;
  constructor(private readonly options: ArtifactWebRtcOptions = {}) {
    this.enabled = options.enabled ?? process.env.MARIFOLD_EXPERIMENTAL_WEBRTC === '1';
    this.timeout = options.timeoutMs ?? 15_000;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const session of [...this.sessions]) session.stop();
    const streams = [...this.downloads.keys()].map(stream => new Promise<void>(resolve => {
      stream.once('close', resolve);
      stream.destroy();
    }));
    await Promise.all([...this.closing, ...streams]);
  }
  private closePeer(pc: RTCPeerConnection): void {
    const closing = pc.close().catch(() => undefined).finally(() => this.closing.delete(closing));
    this.closing.add(closing);
  }
  cancelWorkspace(scope: string): void {
    for (const s of [...this.sessions]) if (s.scope === scope) s.stop();
    for (const [stream, workspace] of this.downloads) if (workspace === scope) stream.destroy();
  }
  private async peer(): Promise<RTCPeerConnection> {
    if (!this.enabled || this.closed || this.activePeers + this.downloads.size >= MAX_SESSIONS) throw new Error('Direct downloads unavailable.');
    const stun = this.options.stunUrl ?? process.env.MARIFOLD_WEBRTC_STUN_URL ?? 'stun:stun.l.google.com:19302';
    if (!/^stun:[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(stun) || (Number(stun.split(':')[2]) < 1 || Number(stun.split(':')[2]) > 65535))
      throw new Error('Invalid local WebRTC STUN URL.');
    this.activePeers++;
    try {
      const { RTCPeerConnection } = await import('werift');
      if (this.closed) throw new Error('Direct downloads unavailable.');
      const pc = new RTCPeerConnection({ iceServers: [{ urls: stun }], ...this.options.peerConfig });
      let released = false;
      pc.connectionStateChange.subscribe(state => {
        if (state === 'closed' && !released) { released = true; this.activePeers--; }
      });
      return pc;
    } catch (error) { this.activePeers--; throw error; }
  }

  async offerFile(artifact: ResolvedRunArtifact, offer: unknown, scope: string): Promise<Description> {
    const remote = description(offer, 'offer');
    if (artifact.size > MAX_FILE) throw new Error('File exceeds experimental direct download limit.');
    const pc = await this.peer();
    let fd: number | undefined;
    let stopped = false;
    let rejectStopped!: (reason: Error) => void;
    const stoppedPromise = new Promise<never>((_, reject) => { rejectStopped = reject; });
    // A rejected lifecycle is observed even after signaling has finished.
    void stoppedPromise.catch(() => undefined);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(idle);
      this.sessions.delete(session);
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
      rejectStopped(new Error('Direct transfer ended.'));
      this.closePeer(pc);
    };
    const session = { scope, stop };
    this.sessions.add(session);
    let idle = setTimeout(stop, this.timeout); idle.unref();
    const timer = setTimeout(stop, 120_000);
    timer.unref();
    pc.connectionStateChange.subscribe(state => { if (state === 'failed' || state === 'closed') stop(); });
    try {
      fd = fs.openSync(artifact.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== artifact.size) throw new Error('Artifact changed.');
      let attached = false;
      pc.onDataChannel.subscribe(channel => {
        if (attached || channel.label !== LABEL || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { stop(); return; }
        attached = true;
        let sent = 0;
        let acknowledged = 0;
        let started = false;
        let ended = false;
        const hash = createHash('sha256');
        channel.onclose = stop;
        channel.onerror = stop;
        channel.onmessage = ({ data }) => {
          try {
            if (stopped || typeof data !== 'string' || data.length > 128) throw new Error('Invalid transfer credit.');
            const message = JSON.parse(data);
            if (message.type !== 'credit' || !Number.isSafeInteger(message.offset) || message.offset < acknowledged || message.offset > sent || (started && message.offset === acknowledged))
              throw new Error('Invalid transfer credit.');
            clearTimeout(idle);
            idle = setTimeout(stop, this.timeout); idle.unref();
            started = true;
            acknowledged = message.offset;
            while (!stopped && sent < artifact.size && sent - acknowledged < WINDOW) {
              const bytes = Buffer.alloc(Math.min(BLOCK, artifact.size - sent));
              if (fs.readSync(fd!, bytes, 0, bytes.length, sent) !== bytes.length) throw new Error('Artifact changed.');
              hash.update(bytes);
              channel.send(bytes);
              sent += bytes.length;
            }
            if (sent === artifact.size && !ended) {
              const after = fs.fstatSync(fd!);
              if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Artifact changed.');
              ended = true;
              channel.send(JSON.stringify({ type: 'end', size: sent, sha256: hash.digest('hex') }));
            }
          } catch { stop(); }
        };
      });
      const negotiate = async () => {
        await pc.setRemoteDescription(remote);
        if (stopped) throw new Error('Direct transfer ended.');
        await pc.setLocalDescription(await pc.createAnswer());
        if (stopped) throw new Error('Direct transfer ended.');
        return description(pc.localDescription, 'answer');
      };
      return await Promise.race([negotiate(), stoppedPromise]);
    } catch (error) { stop(); throw error; }
  }

  async receive(
    size: number,
    signalOffer: (offer: Description) => Promise<unknown>,
    scope: string,
    signal?: AbortSignal,
  ): Promise<Readable> {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('File exceeds experimental direct download limit.');
    const pc = await this.peer();
    let directory: string | undefined;
    let fd: number | undefined;
    let stopped = false;
    let succeeded = false;
    let rejectDone!: (reason: Error) => void;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => undefined);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(idle);
      clearTimeout(lifetime);
      signal?.removeEventListener('abort', stop);
      this.sessions.delete(session);
      this.closePeer(pc);
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
      if (!succeeded && directory) fs.rmSync(directory, { recursive: true, force: true });
      if (!succeeded) rejectDone(new Error('Direct download unavailable or interrupted.'));
    };
    const session = { scope, stop };
    this.sessions.add(session);
    let idle = setTimeout(stop, this.timeout);
    const lifetime = setTimeout(stop, 120_000);
    idle.unref(); lifetime.unref();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw new Error('Download cancelled.');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-download-'));
      fs.chmodSync(directory, 0o700);
      const filename = path.join(directory, 'artifact');
      fd = fs.openSync(filename, 'wx', 0o600);
      const channel: RTCDataChannel = pc.createDataChannel(LABEL, { ordered: true });
      let received = 0;
      let credited = 0;
      const hash = createHash('sha256');
      channel.onopen = () => {
        try { if (!stopped) channel.send(JSON.stringify({ type: 'credit', offset: 0 })); }
        catch { stop(); }
      };
      channel.onclose = stop;
      channel.onerror = stop;
      pc.connectionStateChange.subscribe(state => { if (state === 'failed' || state === 'closed') stop(); });
      channel.onmessage = ({ data }) => {
        if (stopped) return;
        try {
          clearTimeout(idle);
          idle = setTimeout(stop, this.timeout); idle.unref();
          if (Buffer.isBuffer(data)) {
            if (!data.length || data.length > BLOCK || received + data.length > size) throw new Error('Invalid file bytes.');
            let offset = 0;
            while (offset < data.length) {
              const written = fs.writeSync(fd!, data, offset, data.length - offset);
              if (!written) throw new Error('Could not save direct download.');
              offset += written;
            }
            hash.update(data);
            received += data.length;
            if (received - credited >= WINDOW / 2) {
              credited = received;
              channel.send(JSON.stringify({ type: 'credit', offset: received }));
            }
          } else {
            if (data.length > 256) throw new Error('Invalid transfer result.');
            const message = JSON.parse(data);
            if (message.type !== 'end' || received !== size || message.size !== size || message.sha256 !== hash.digest('hex'))
              throw new Error('Incomplete or corrupt direct download.');
            succeeded = true;
            resolveDone();
            stop();
          }
        } catch { stop(); }
      };
      const negotiate = async () => {
        await pc.setLocalDescription(await pc.createOffer());
        if (stopped) throw new Error('Download cancelled.');
        const answer = await signalOffer(description(pc.localDescription, 'offer'));
        if (stopped) throw new Error('Download cancelled.');
        await pc.setRemoteDescription(description(answer, 'answer'));
        await done;
      };
      await Promise.race([negotiate(), done]);
      if (!succeeded) throw new Error('Direct download incomplete.');
      const stream = fs.createReadStream(filename);
      const completedDirectory = directory;
      this.downloads.set(stream, scope);
      stream.once('close', () => {
        this.downloads.delete(stream);
        fs.rmSync(completedDirectory, { recursive: true, force: true });
      });
      return stream;
    } catch (error) { stop(); throw error; }
  }
}
