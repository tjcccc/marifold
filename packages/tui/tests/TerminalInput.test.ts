import { describe, expect, it, vi } from 'vitest';
import { TerminalInput } from '../src/core/TerminalInput.js';

function setup(mouse = true) {
  const input = new TerminalInput(process.stdin, mouse);
  let output = '';
  const events = vi.fn();
  input.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  input.on('mouse', events);
  return { input, events, output: () => output };
}

describe('terminal input boundary', () => {
  it('extracts fragmented and batched SGR reports without leaking them into keyboard input', () => {
    const { input, events, output } = setup();
    input.write('hello\x1b[<0;');
    input.write('4;5M\x1b[<32;6;5M\x1b[<0;6;5m\x1b[<65;4;5M!');
    expect(output()).toBe('hello!');
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { x: 3, y: 4, button: 0, shift: false, action: 'press' },
      { x: 5, y: 4, button: 0, shift: false, action: 'move' },
      { x: 5, y: 4, button: 0, shift: false, action: 'release' },
      { x: 3, y: 4, button: 1, shift: false, action: 'wheel' },
    ]);
    input.destroy();
  });

  it('normalizes modified Enter split between stdin chunks', () => {
    const { input, output } = setup();
    input.write('\x1b[27');
    input.write(';5;');
    input.write('13~');
    expect(output()).toBe('\x1b[13;5u');
    input.destroy();
  });

  it('preserves literal escape sequences inside fragmented bracketed pastes', () => {
    const { input, events, output } = setup();
    input.write('\x1b[200');
    input.write('~你😀\x1b[<0;4;5M\x1b[27;5;13~\x1b[201');
    input.write('~\x1b[27;5;13~');
    expect(output()).toBe('\x1b[200~你😀\x1b[<0;4;5M\x1b[27;5;13~\x1b[201~\x1b[13;5u');
    expect(events).not.toHaveBeenCalled();
    input.destroy();
  });

  it('preserves split UTF-8 characters and disables mouse handling in inline mode', () => {
    const { input, events, output } = setup(false);
    const bytes = Buffer.from('你😀');
    input.write(bytes.subarray(0, 4));
    input.write(bytes.subarray(4));
    input.write('\x1b[<0;4;5M');
    expect(output()).toBe('你😀');
    expect(events).not.toHaveBeenCalled();
    input.destroy();
  });

  it('forwards a standalone Escape after a bounded wait and cancels timers at teardown', async () => {
    vi.useFakeTimers();
    try {
      const { input, output } = setup();
      input.write('\x1b');
      await vi.advanceTimersByTimeAsync(25);
      expect(output()).toBe('\x1b');
      input.write('\x1b[<0;');
      input.destroy();
      await vi.advanceTimersByTimeAsync(25);
      expect(output()).toBe('\x1b');
    } finally { vi.useRealTimers(); }
  });
});
