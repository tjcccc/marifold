import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ReadStream } from 'node:tty';
import type { MouseEvent } from '../ui/Mouse.js';

export const MOUSE_ENABLE = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_DISABLE = '\x1b[?1002l\x1b[?1006l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Ink 8 discards mouse reports and unrecognized modifyOtherKeys sequences.
 * Extract SGR mouse reports before Ink, preserving literal bracketed pastes. */
export class TerminalInput extends Transform {
  private pending = '';
  private pasting = false;
  private decoder = new StringDecoder('utf8');
  private timer?: ReturnType<typeof setTimeout>;
  readonly isTTY: boolean;

  constructor(private source: ReadStream, private mouse: boolean) {
    super();
    this.isTTY = source.isTTY;
  }

  setRawMode(enabled: boolean): this { this.source.setRawMode(enabled); return this; }
  ref(): this { this.source.ref(); return this; }
  unref(): this { this.source.unref(); return this; }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.pending += this.decoder.write(chunk);
    this.drain();
    // Preserve a standalone Escape; don't wait indefinitely for another byte.
    if (this.pending && !this.pasting) {
      this.timer = setTimeout(() => {
        this.push(this.pending);
        this.pending = '';
      }, 25);
    }
    callback();
  }

  private drain(): void {
    let output = '';
    const flush = () => { if (output) { this.push(output); output = ''; } };
    while (this.pending) {
      const marker = this.pasting ? PASTE_END : PASTE_START;
      if (this.pending.startsWith(marker)) {
        output += marker;
        this.pending = this.pending.slice(marker.length);
        this.pasting = !this.pasting;
        continue;
      }
      if (marker.startsWith(this.pending)) { flush(); return; }
      if (!this.pasting) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
        if (match) {
          const code = Number(match[1]);
          const event: MouseEvent = {
            x: Number(match[2]) - 1, y: Number(match[3]) - 1,
            button: code & 3, shift: Boolean(code & 4),
            action: code & 64 ? 'wheel' : match[4] === 'm' ? 'release' : code & 32 ? 'move' : 'press',
          };
          flush();
          if (this.mouse) { this.emit('mouse', event); }
          this.pending = this.pending.slice(match[0].length);
          continue;
        }
        const enter = /^\x1b\[27;(\d+);13~/.exec(this.pending);
        if (enter) {
          output += `\x1b[13;${enter[1]}u`;
          this.pending = this.pending.slice(enter[0].length);
          continue;
        }
        if (/^\x1b\[<(?:\d*(?:;\d*){0,2})$/.test(this.pending) ||
            /^\x1b\[27(?:;\d*(?:;\d*)?)?$/.test(this.pending)) { flush(); return; }
      }
      // Forward ordinary text/escape sequences without interpreting them.
      // Holding a marker prefix also handles reports split across stdin chunks.
      const length = (this.pending.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      output += this.pending.slice(0, length);
      this.pending = this.pending.slice(length);
    }
    flush();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.source.unpipe(this);
    callback(error);
  }
}
