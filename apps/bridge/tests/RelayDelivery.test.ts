import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ rows: [] as Array<[string, string[]]>, subscribers: [] as Array<{ emit: (event: string) => void }> }));
vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');
  class MockRedis extends EventEmitter {
    duplicate() {
      const subscriber = new MockRedis();
      fake.subscribers.push(subscriber);
      return subscriber;
    }
    async subscribe() {}
    async xrange(_key: string, start: string) {
      const [startMs, startSequence] = start.split('-').map(BigInt);
      return fake.rows.filter(([id]) => {
        const [ms, sequence] = id.split('-').map(BigInt);
        return ms > startMs || (ms === startMs && sequence >= startSequence);
      });
    }
    disconnect() {}
  }
  return { default: MockRedis };
});
import { RedisRelayStore } from '../src/Store';

afterEach(() => { fake.rows.length = 0; fake.subscribers.length = 0; });

it('delivers retained packets once per connection and replays them after reconnect until acknowledged', async () => {
  const store = new RedisRelayStore('redis://disposable-fixture');
  const id = Date.now();
  fake.rows.push([`${id}-0`, ['packet', 'first']]);
  const received: string[] = [];
  const stop = await store.receive('workspace', 'guest', (_id, packet) => received.push(packet));
  expect(received).toEqual(['first']);
  // Leave the first packet unacknowledged while new publishes trigger reads.
  fake.rows.push([`${id}-1`, ['packet', 'second']]);
  fake.subscribers[0].emit('message');
  await expect.poll(() => received).toEqual(['first', 'second']);
  fake.rows.push([`${id}-2`, ['packet', 'third']]);
  fake.subscribers[0].emit('message');
  await expect.poll(() => received).toEqual(['first', 'second', 'third']);
  fake.subscribers[0].emit('message');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(received).toEqual(['first', 'second', 'third']);
  stop();
  fake.rows.shift(); // First packet was acknowledged; the other two remain durable.
  const replay: string[] = [];
  const stopReplay = await store.receive('workspace', 'guest', (_id, packet) => replay.push(packet));
  expect(replay).toEqual(['second', 'third']);
  stopReplay();
  await store.close();
});
