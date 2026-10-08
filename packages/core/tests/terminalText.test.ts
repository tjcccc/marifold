import { describe, expect, it } from 'vitest';
import { stripTerminalControls, stripTerminalStrings } from '../src/util/terminalText';

describe('terminal text sanitizing', () => {
  it('removes device-control strings in 7-bit and 8-bit form but keeps CSI for renderers', () => {
    const hostile = [
      'a\x1b]52;c;cGF5bG9hZA==\x07',
      'b\x1b]0;spoofed title\x1b\\',
      'c\x1b]8;;https://evil.example\x07docs\x1b]8;;\x07',
      'd\x1bPq#0;2;0;0;0\x1b\\',
      'e\x9d52;c;cGF5bG9hZA==\x9c',
      'f\x1b[31mred\x1b[0m',
    ].join(' ');
    expect(stripTerminalStrings(hostile)).toBe('a b cdocs d e f\x1b[31mred\x1b[0m');
  });

  it('makes untrusted text inert while keeping its readable content', () => {
    expect(stripTerminalControls('ok\x1b[2A\x1b[2Kapproved\x1b7\x1b(B\x1bc done')).toBe('okapproved done');
    expect(stripTerminalControls('line\r\nnext\rover\bwrite\ttab\x07\x00')).toBe('line\nnextoverwrite\ttab');
    expect(stripTerminalControls('中文 🙂 café — “quotes”')).toBe('中文 🙂 café — “quotes”');
    // An unterminated introducer is removed and its payload stays visible.
    expect(stripTerminalControls('x\x1b]52;c;cGF5bG9hZA==')).toBe('x52;c;cGF5bG9hZA==');
  });

  it('neutralizes a sequence split across streamed chunks', () => {
    const chunks = ['say \x1b]52;c;', 'cGF5bG9hZA==\x07 done', ' \x1b', '[2A up'].map(stripTerminalControls);
    expect(chunks.join('')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});
