import { identifier, randomId } from '@marifold/workspace-protocol';

const CHUNK_SIZE = 96000;
const WINDOW = 4;
const PEER_WINDOW = 8;
const TRANSFER_LIMIT = 40 * 1024 * 1024;
interface Assembly {
  parts: string[];
  next: number;
  last?: number;
  bytes: number;
  expires: number;
}
interface Acknowledgment {
  recipient: string;
  accept: (window: number) => void;
  reject: () => void;
}
type Send = (value: unknown) => Promise<void>;

/** Bounded bulk traffic shares the connection without holding up ordinary messages. */
export class ChunkTransfers {
  private assemblies = new Map<string, Assembly>();
  private acknowledgments = new Map<string, Acknowledgment>();
  private slots: Array<() => void> = [];
  private active = 0;
  private generation = 0;

  reset(): void {
    this.generation++;
    this.assemblies.clear();
    for (const ack of this.acknowledgments.values()) ack.reject();
    this.acknowledgments.clear();
  }

  acknowledge(sender: string, frame: Record<string, unknown>): void {
    const ack = this.acknowledgments.get(`${frame.transfer}:${frame.index}`);
    if (ack?.recipient === sender) ack.accept(frame.window === WINDOW ? WINDOW : 1);
  }

  receive(sender: string, frame: Record<string, unknown>): { ack: Record<string, unknown>; text?: string } {
    const transfer = identifier(frame.transfer);
    const index = frame.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 1024 ||
      typeof frame.data !== 'string' || frame.data.length === 0 || frame.data.length > 128000 ||
      typeof frame.last !== 'boolean') throw new Error('Invalid transfer chunk.');
    const key = `${sender}:${transfer}`;
    for (const [id, item] of this.assemblies) if (item.expires < Date.now()) this.assemblies.delete(id);
    let item = this.assemblies.get(key);
    if (!item) {
      if (this.assemblies.size >= 16 || index !== 0) throw new Error('Invalid transfer.');
      item = { parts: [], next: 0, bytes: 0, expires: Date.now() + 60000 };
      this.assemblies.set(key, item);
    }
    // Chunk zero negotiates the window before the sender pipelines further chunks.
    if (index >= item.next + WINDOW || item.parts[index] !== undefined ||
      (item.last !== undefined && index > item.last) ||
      (frame.last && (item.last !== undefined || item.parts.length > index + 1)))
      throw new Error('Out-of-order transfer.');
    item.parts[index] = frame.data;
    item.bytes += frame.data.length;
    item.expires = Date.now() + 60000;
    if (frame.last) item.last = index;
    if (item.bytes > TRANSFER_LIMIT ||
      [...this.assemblies.values()].reduce((total, entry) => total + entry.bytes, 0) > 64 * 1024 * 1024) {
      this.assemblies.delete(key);
      throw new Error('Transfer limit exceeded.');
    }
    while (item.parts[item.next] !== undefined) item.next++;
    const ack = { type: 'chunk_ack', transfer, index, window: WINDOW };
    if (item.last === undefined || item.next !== item.last + 1) return { ack };
    this.assemblies.delete(key);
    return { ack, text: Buffer.from(item.parts.join(''), 'base64').toString('utf8') };
  }

  async transmit(recipient: string, text: string, send: Send, relayWindow = WINDOW): Promise<void> {
    const encoded = Buffer.from(text).toString('base64');
    if (encoded.length > TRANSFER_LIMIT) throw new Error('Transfer exceeds limit.');
    const transfer = randomId();
    const generation = this.generation;
    const chunkSize = relayWindow === WINDOW ? CHUNK_SIZE : 48000;
    const chunk = (index: number) => this.sendChunk(recipient, {
      type: 'chunk', transfer, index,
      data: encoded.slice(index * chunkSize, (index + 1) * chunkSize),
      last: (index + 1) * chunkSize >= encoded.length,
    }, send, generation);
    // Old receivers omit window and continue to receive one chunk at a time.
    const window = Math.min(await chunk(0), relayWindow);
    const count = Math.ceil(encoded.length / chunkSize);
    for (let index = 1; index < count; index += window) {
      await Promise.all(Array.from({ length: Math.min(window, count - index) }, (_, offset) => chunk(index + offset)));
    }
  }

  private async sendChunk(
    recipient: string,
    frame: Record<string, unknown> & { transfer: string; index: number },
    send: Send,
    generation: number,
  ): Promise<number> {
    if (this.active >= PEER_WINDOW) await new Promise<void>(resolve => this.slots.push(resolve));
    else this.active++;
    try {
      if (generation !== this.generation) throw new Error('Transfer disconnected.');
      return await new Promise<number>((resolve, reject) => {
        const key = `${frame.transfer}:${frame.index}`;
        const finish = (error?: Error, window = 1) => {
          clearTimeout(timer);
          this.acknowledgments.delete(key);
          if (error) reject(error);
          else resolve(window);
        };
        const timer = setTimeout(() => finish(new Error('Transfer acknowledgment timed out.')), 15000);
        this.acknowledgments.set(key, {
          recipient,
          accept: window => finish(undefined, window),
          reject: () => finish(new Error('Transfer disconnected.')),
        });
        void send(frame).catch(error => finish(error));
      });
    } finally {
      const resume = this.slots.shift();
      if (resume) resume();
      else this.active--;
    }
  }
}
