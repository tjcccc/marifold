import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkTransfers } from '../src/workspace/bridge/ChunkTransfers';

afterEach(() => vi.useRealTimers());

describe('bounded workspace transfers', () => {
  it.each([false, true])('preserves multi-megabyte bytes with legacy receiver=%s', async legacy => {
    vi.useFakeTimers();
    const sender = new ChunkTransfers();
    const receiver = new ChunkTransfers();
    const text = JSON.stringify({ data: 'many bytes 🐈 '.repeat(200000) });
    let output: string | undefined;
    let active = 0;
    let peak = 0;
    let legacyIndex = 0;
    const started = Date.now();
    const job = sender.transmit('guest', text, async value => {
      const frame = value as Record<string, unknown>;
      peak = Math.max(peak, ++active);
      setTimeout(() => {
        if (legacy) expect(frame.index).toBe(legacyIndex++);
        const result = receiver.receive('host', frame);
        if (result.text !== undefined) output = result.text;
        setTimeout(() => {
          active--;
          sender.acknowledge('guest', legacy ? { ...result.ack as object, window: undefined } : result.ack as Record<string, unknown>);
        }, 50);
      }, 50);
    });
    await vi.runAllTimersAsync();
    await job;
    expect(output).toBe(text);
    expect(peak).toBe(legacy ? 1 : 4);
    const chunks = Math.ceil(Buffer.byteLength(text) * 4 / 3 / 96000);
    expect(Date.now() - started).toBe((legacy ? chunks : 1 + Math.ceil((chunks - 1) / 4)) * 100);
  });

  it('reassembles out-of-order chunks, including a final chunk arriving early', () => {
    const receiver = new ChunkTransfers();
    const encoded = Buffer.from('complete transfer').toString('base64');
    const frame = (index: number) => ({ transfer: 'one', index, data: encoded.slice(index * 8, (index + 1) * 8), last: index === 2 });
    expect(receiver.receive('host', frame(0)).text).toBeUndefined();
    expect(receiver.receive('host', frame(2)).text).toBeUndefined();
    expect(receiver.receive('host', frame(1)).text).toBe('complete transfer');
    expect(() => receiver.receive('host', { ...frame(0), index: 500000 })).toThrow('Invalid');
  });

  it('bounds concurrent bulk frames across transfers and rejects acknowledgments from other devices', async () => {
    vi.useFakeTimers();
    const sender = new ChunkTransfers();
    const receivers = [new ChunkTransfers(), new ChunkTransfers(), new ChunkTransfers()];
    let active = 0;
    let peak = 0;
    let completed = 0;
    const jobs = receivers.map((receiver, i) => sender.transmit(`guest_${i}`, 'x'.repeat(600000), async value => {
      peak = Math.max(peak, ++active);
      const frame = value as Record<string, unknown>;
      sender.acknowledge('wrong-device', { ...frame, window: 4 });
      setTimeout(() => {
        const { ack, text } = receiver.receive('host', frame);
        if (text) completed++;
        active--;
        sender.acknowledge(`guest_${i}`, ack as Record<string, unknown>);
      }, 100);
    }));
    await vi.advanceTimersByTimeAsync(1);
    expect(active).toBe(3);
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    expect(peak).toBe(8);
    expect(completed).toBe(3);
  });

  it('releases pending and queued transfers on disconnect and can transfer after reconnect', async () => {
    const sender = new ChunkTransfers();
    const send = vi.fn(async () => undefined);
    const jobs = Array.from({ length: 12 }, () => sender.transmit('guest', 'x'.repeat(100000), send));
    const results = Promise.allSettled(jobs);
    expect(send).toHaveBeenCalledTimes(8);
    sender.reset();
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    const receiver = new ChunkTransfers();
    await sender.transmit('guest', 'after reconnect', async value => {
      const result = receiver.receive('host', value as Record<string, unknown>);
      expect(result.text).toBe('after reconnect');
      sender.acknowledge('guest', result.ack as Record<string, unknown>);
    });
  });
});
