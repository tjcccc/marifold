import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { selectTerminalOption } from '../src/input/TerminalSelect';

/** Minimal raw-mode TTY stdin stub the selector can drive. */
class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  send(seq: string): void {
    this.emit('data', Buffer.from(seq, 'utf8'));
  }
}

/** TTY stdout stub of a fixed height that records every write. */
class FakeOutput {
  isTTY = true;
  writes: string[] = [];
  constructor(public rows: number, public columns = 80) {}
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';

function options(n: number): Array<{ label: string; value: string }> {
  return Array.from({ length: n }, (_, i) => ({ label: `model-${i}`, value: `model-${i}` }));
}

/** Lines drawn by the most recent full render (between the last cursor-up and ENTER). */
function lastFrameLines(output: FakeOutput): string[] {
  return output.writes.join('').split('\n');
}

describe('selectTerminalOption viewport', () => {
  it('caps the rendered block to the terminal height for a long list', async () => {
    const input = new FakeInput();
    const output = new FakeOutput(20); // 20-row terminal
    const promise = selectTerminalOption('Select model:', options(60), {
      input: input as never,
      output: output as never,
    });
    // Let the initial render flush, then accept the default.
    await Promise.resolve();
    input.send(ENTER);
    await promise;

    // Count option rows actually drawn in the first frame (lines beginning with the
    // selected/unselected prefixes). Must be far below the list length and the
    // terminal height — never all 60.
    const optionRows = lastFrameLines(output).filter(line => / » |   model-/.test(line));
    expect(optionRows.length).toBeLessThanOrEqual(20);
    expect(optionRows.length).toBeLessThan(60);
  });

  it('keeps the selected option inside the rendered window after paging down', async () => {
    const input = new FakeInput();
    const output = new FakeOutput(12);
    const promise = selectTerminalOption('Select model:', options(60), {
      input: input as never,
      output: output as never,
    });
    await Promise.resolve();

    // Page well past the first window.
    for (let i = 0; i < 30; i += 1) input.send(DOWN);
    output.writes.length = 0; // isolate the next render
    input.send(DOWN); // selectedIndex = 31, triggers a fresh render
    const frame = lastFrameLines(output);
    // The selected row (» prefix) must be present in the rendered window.
    expect(frame.some(line => line.includes(' » '))).toBe(true);
    expect(frame.some(line => line.includes('more'))).toBe(true); // scroll hint shown

    input.send(ENTER);
    const selected = await promise;
    expect(selected).toBe('model-31');
  });

  it('shows every option without a scroll hint when the list fits', async () => {
    const input = new FakeInput();
    const output = new FakeOutput(40);
    const promise = selectTerminalOption('Select model:', options(5), {
      input: input as never,
      output: output as never,
    });
    await Promise.resolve();
    input.send(UP); // wrap to last
    const frame = lastFrameLines(output);
    expect(frame.some(line => line.includes('more'))).toBe(false);

    input.send(ENTER);
    expect(await promise).toBe('model-4');
  });

  it('clips lines wider than the terminal so each stays a single physical row', async () => {
    const input = new FakeInput();
    const output = new FakeOutput(20, 24); // 24 columns wide
    const longLabel = 'qwen3.5-livetranslate-flash-realtime-2026-05-19';
    const promise = selectTerminalOption(
      'Select model:',
      [{ label: longLabel, value: longLabel }, { label: 'short', value: 'short' }],
      { input: input as never, output: output as never },
    );
    await Promise.resolve();
    // Every emitted display line (after stripping the \x1b[2K clear) must fit the width.
    for (const line of output.writes.join('').split('\n')) {
      const visibleText = line.replace(/\x1b\[[0-9]*[A-Za-z]/g, '');
      expect(visibleText.length).toBeLessThanOrEqual(24);
    }
    input.send(ENTER);
    await promise;
  });
});
