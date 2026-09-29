import { describe, expect, it, vi } from 'vitest';

const tty = vi.hoisted(() => ({ raw: false, listener: undefined as undefined | ((data: Buffer) => void), writes: [] as string[] }));
vi.mock('process', () => ({
  stdin: {
    isTTY: true,
    get isRaw() { return tty.raw; },
    setRawMode(value: boolean) { tty.raw = value; },
    resume() {}, pause() {},
    on(_event: string, listener: (data: Buffer) => void) { tty.listener = listener; },
    off() { tty.listener = undefined; },
  },
  stdout: {
    isTTY: true,
    write(value: string) {
      tty.writes.push(value);
      if (value === 'Secret: ') {
        // Simulate a paste as soon as the prompt becomes visible.
        expect(tty.raw).toBe(true);
        expect(tty.listener).toBeDefined();
        tty.listener!(Buffer.from(' secret-canary \r'));
      }
    },
  },
}));
import { readSecretLine } from '../src/input/SecretPrompt';

describe('secure password input', () => {
  it('disables terminal echo before inviting input, preserves spaces, and never echoes the secret', async () => {
    const value = await readSecretLine('Secret: ', () => { throw new Error('No fallback'); }, false);
    expect(value).toBe(' secret-canary ');
    expect(tty.writes.join('')).not.toContain('secret-canary');
    expect(tty.raw).toBe(false);
    expect(tty.listener).toBeUndefined();
  });
});
