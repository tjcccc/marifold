import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { bandColor, parseOsc11, probeTerminalBackground } from '../src/core/terminalBackground.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  modes: boolean[] = [];
  setRawMode(mode: boolean) { this.modes.push(mode); this.isRaw = mode; }
  resume() {}
  pause() {}
}

describe('terminal background', () => {
  it('parses OSC 11 replies of 1–4 hex digits per channel', () => {
    expect(parseOsc11('\x1b]11;rgb:1111/1313/1818\x1b\\')).toEqual({ r: 17, g: 19, b: 24 });
    expect(parseOsc11('\x1b]11;rgb:ff/ff/ff\x07')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOsc11('garbage')).toBeUndefined();
  });

  it('shades the band lighter on dark backgrounds and darker on light ones', () => {
    expect(bandColor({ r: 17, g: 19, b: 24 })).toBe('#1F2126');
    expect(bandColor({ r: 255, g: 255, b: 255 })).toBe('#F0F0F0');
  });

  it('reads the reply up to the DA1 answer and restores the input mode', async () => {
    const input = new FakeInput();
    const written: string[] = [];
    const probe = probeTerminalBackground(input, { isTTY: true, write: text => { written.push(text); input.emit('data', Buffer.from('\x1b]11;rgb:1111/1313/1818\x1b\\\x1b[?62;22c')); } });
    await expect(probe).resolves.toEqual({ r: 17, g: 19, b: 24 });
    expect(written[0]).toContain('\x1b]11;?');
    expect(input.modes).toEqual([true, false]);
  });

  it('gives up when the terminal answers only DA1 or nothing, and skips non-terminals', async () => {
    const input = new FakeInput();
    await expect(probeTerminalBackground(input, { isTTY: true, write: () => { input.emit('data', '\x1b[?1;2c'); } })).resolves.toBeUndefined();
    await expect(probeTerminalBackground(new FakeInput(), { isTTY: true, write: () => undefined }, 10)).resolves.toBeUndefined();
    await expect(probeTerminalBackground(new FakeInput(), { isTTY: false, write: () => undefined })).resolves.toBeUndefined();
  });
});
