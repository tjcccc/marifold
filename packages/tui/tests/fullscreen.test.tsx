import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { FullScreen } from '../src/ui/FullScreen.js';
import { InputBox } from '../src/ui/InputBox.js';
import { MouseContext, SelectionCopyContext, type MouseEvent } from '../src/ui/Mouse.js';
import { mapSelectionLines, selectedText } from '../src/ui/selection.js';
import { locateVisualCursor, wrapToVisualLines, offsetAtColumn } from '../src/ui/inputLayout.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 30));
const message = (length: number) => ({ id: 'answer', kind: 'assistant' as const, text: Array.from({ length }, (_, i) => `row ${String(i).padStart(2, '0')} content`).join('\n') });
function mouse(source: EventEmitter, action: MouseEvent['action'], x: number, y: number, button = 0) {
  source.emit('mouse', { action, x, y, button, shift: false });
}

describe('full-screen transcript', () => {
  it('bounds history, pauses following while scrolled up, and returns to the latest output', async () => {
    const source = new EventEmitter();
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const tree = (length: number) => <MouseContext.Provider value={source}><FullScreen items={[message(length)]} header={<Text>Header</Text>} footer={<Text>Composer</Text>} keyboardActive onCopy={onCopy} /></MouseContext.Provider>;
    const { lastFrame, stdin, rerender, unmount } = render(tree(60));
    await vi.waitFor(() => expect(lastFrame()).toContain('row 59 content'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(23);
    stdin.write('\x1b[5~');
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('row 59 content');
      expect(lastFrame()).toContain('History paused');
    });
    const first = lastFrame()?.split('\n')[0];
    rerender(tree(70));
    await delay();
    expect(lastFrame()?.split('\n')[0]).toBe(first);
    stdin.write('\x1b[1;5F');
    await vi.waitFor(() => expect(lastFrame()).toContain('row 69 content'));
    mouse(source, 'wheel', 2, 0, 0);
    await vi.waitFor(() => expect(lastFrame()).toContain('History paused'));
    expect(onCopy).not.toHaveBeenCalled();
    unmount();
  });

  it('copies a drag on release, even with batched mouse events and a streaming update', async () => {
    const source = new EventEmitter();
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const tree = (length: number) => <MouseContext.Provider value={source}><FullScreen items={[message(length)]} header={<Text>Header</Text>} footer={<Text>Composer</Text>} keyboardActive workspaceNotice="Local workspace" onCopy={onCopy} /></MouseContext.Provider>;
    const { lastFrame, rerender, unmount } = render(tree(60));
    await vi.waitFor(() => expect(lastFrame()).toContain('row 59 content'));
    const expected = lastFrame()!.split('\n')[0].slice(1, 7);
    mouse(source, 'press', 1, 0);
    mouse(source, 'move', 7, 0);
    expect(onCopy).not.toHaveBeenCalled();
    rerender(tree(70));
    await delay();
    mouse(source, 'release', 7, 0);
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith(expected));
    await vi.waitFor(() => expect(lastFrame()).toContain('Copied'));
    const status = lastFrame()!.split('\n').find(line => line.includes('Copied'))!;
    expect(status.trimEnd()).toMatch(/^ Local workspace\s+Copied$/);
    expect(status.indexOf('Copied')).toBeGreaterThan(80);
    expect(lastFrame()).not.toContain('row 69 content');
    unmount();
  });

  it('preserves blank rows and transcript spacing while selecting across messages', async () => {
    const source = new EventEmitter();
    const { lastFrame, unmount } = render(<MouseContext.Provider value={source}>
      <FullScreen items={[
        { id: 'prompt1', kind: 'user', text: '$example first' },
        { id: 'answer1', kind: 'assistant', text: 'First paragraph\n\nSecond paragraph' },
        { id: 'prompt2', kind: 'user', text: '$example second' },
        { id: 'answer2', kind: 'assistant', text: 'Last paragraph' },
      ]} header={<Text>Header</Text>} footer={<Text>Composer</Text>} keyboardActive onCopy={vi.fn().mockResolvedValue(undefined)} />
    </MouseContext.Provider>);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('Last paragraph'));
      const before = lastFrame()!.split('\n');
      const start = before.findIndex(line => line.includes('$example first'));
      const end = before.findIndex(line => line.includes('Last paragraph'));
      const hint = before.findIndex(line => line.includes('Wheel / PgUp'));
      mouse(source, 'press', 1, start);
      mouse(source, 'move', 10, end);
      await vi.waitFor(() => expect(lastFrame()).toContain('History paused'));
      const after = lastFrame()!.split('\n');
      expect(after.slice(0, hint)).toEqual(before.slice(0, hint));
      expect(after.findIndex(line => line.includes('Composer'))).toBe(before.findIndex(line => line.includes('Composer')));
    } finally { unmount(); }
  });

  it('copies wrapped prose as one paragraph while retaining blank paragraphs and code newlines', async () => {
    const source = new EventEmitter();
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const paragraph = 'A long paragraph with wrapped words. '.repeat(5).trim();
    const { lastFrame, unmount } = render(<MouseContext.Provider value={source}>
      <FullScreen items={[
        { id: 'prompt', kind: 'user', text: '$example' },
        { id: 'answer', kind: 'assistant', text: paragraph + '\n\nlast paragraph\n\n```\nfirst code line\nsecond code line\n```' },
      ]} header={<Text>Header</Text>} footer={<Text>Composer</Text>} keyboardActive onCopy={onCopy} />
    </MouseContext.Provider>);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('second code line'));
      const rows = lastFrame()!.split('\n');
      const start = rows.findIndex(line => line.includes('A long paragraph'));
      const end = rows.findIndex(line => line.includes('second code line'));
      mouse(source, 'press', 1, start);
      mouse(source, 'move', 2 + 'second code line'.length, end);
      mouse(source, 'release', 2 + 'second code line'.length, end);
      await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith(`${paragraph}\n\nlast paragraph\n\n first code line\n second code line`));
    } finally { unmount(); }
  });

  it('leaves the clipboard and automatic following unchanged for a click without a drag', async () => {
    const source = new EventEmitter();
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const tree = (length: number) => <MouseContext.Provider value={source}><FullScreen items={[message(length)]} header={<Text>Header</Text>} footer={<Text>Composer</Text>} keyboardActive onCopy={onCopy} /></MouseContext.Provider>;
    const { lastFrame, rerender, unmount } = render(tree(60));
    await vi.waitFor(() => expect(lastFrame()).toContain('row 59 content'));
    mouse(source, 'press', 3, 0);
    mouse(source, 'release', 3, 0);
    await delay();
    rerender(tree(70));
    await vi.waitFor(() => expect(lastFrame()).toContain('row 69 content'));
    expect(onCopy).not.toHaveBeenCalled();
    unmount();
  });

  it.each([false, true])('selects and copies a multiline composer drag (reverse: %s) without altering the draft', async reverse => {
    const source = new EventEmitter();
    const onCopy = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<MouseContext.Provider value={source}>
      <SelectionCopyContext.Provider value={onCopy}>
        <InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} commands={[]} skills={[]} />
      </SelectionCopyContext.Provider>
    </MouseContext.Provider>);
    try {
      stdin.write('你😀ab');
      await delay();
      stdin.write('\n');
      await delay();
      stdin.write('second');
      await delay();
      const from = reverse ? [5, 2] : [4, 1];
      const to = reverse ? [4, 1] : [5, 2];
      mouse(source, 'press', from[0], from[1]);
      mouse(source, 'move', to[0], to[1]);
      expect(onCopy).not.toHaveBeenCalled();
      mouse(source, 'release', to[0], to[1]);
      await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('😀ab\nsec'));
      expect(lastFrame()).not.toContain('�');
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('你😀ab\nsecond', []));
    } finally { unmount(); }
  });

  it('shows the shared Copied feedback for composer selections', async () => {
    const source = new EventEmitter();
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const { stdin, lastFrame, unmount } = render(<MouseContext.Provider value={source}>
      <FullScreen items={[]} header={<Text>Header</Text>} keyboardActive onCopy={onCopy}
        footer={<InputBox onSubmit={() => {}} onInterrupt={() => {}} history={[]} commands={[]} skills={[]} />} />
    </MouseContext.Provider>);
    try {
      stdin.write('draft text');
      await vi.waitFor(() => expect(lastFrame()).toContain('draft text'));
      const row = lastFrame()!.split('\n').findIndex(line => line.includes('draft text'));
      mouse(source, 'press', 2, row);
      mouse(source, 'release', 2, row); // a click must not copy
      expect(onCopy).not.toHaveBeenCalled();
      mouse(source, 'press', 2, row);
      mouse(source, 'move', 7, row);
      mouse(source, 'release', 7, row);
      await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('draft'));
      await vi.waitFor(() => expect(lastFrame()).toContain('Copied'));
    } finally { unmount(); }
  });

  it('places the composer caret by terminal cells without splitting Chinese text or emoji', async () => {
    const source = new EventEmitter();
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<MouseContext.Provider value={source}><InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} commands={[]} skills={[]} /></MouseContext.Provider>);
    stdin.write('你😀b');
    await delay();
    mouse(source, 'press', 4, 1); // two prompt cells + two cells for 你
    stdin.write('X');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSubmit).toHaveBeenCalledWith('你X😀b', []);
    expect(lastFrame()).not.toContain('�');
    unmount();
  });
});

describe('terminal cell mapping', () => {
  it('wraps and locates wide and combining graphemes', () => {
    const lines = wrapToVisualLines('你😀e\u0301z', 4);
    expect(lines).toEqual([{ text: '你😀', start: 0 }, { text: 'e\u0301z', start: 3 }]);
    expect(locateVisualCursor(lines, 3)).toEqual({ line: 1, column: 0 });
    expect(offsetAtColumn('你😀z', 3)).toBe(1);
    expect(offsetAtColumn('e\u0301z', 1)).toBe(2);
  });

  it('joins visual wraps using original spaces and preserves explicit newlines', () => {
    const lines = mapSelectionLines([' one two', ' threefour', ' five', ' ', ' explicit', ' newline'],
      [' one two threefour five', ' ', ' explicit', ' newline']);
    expect(selectedText(lines, { anchor: { row: 0, column: 1 }, focus: { row: 5, column: 8 } })).toBe('one two threefour five\n\nexplicit\nnewline');
    expect(selectedText(lines, { anchor: { row: 1, column: 4 }, focus: { row: 0, column: 5 } })).toBe('two thr');
  });

  it('joins mid-word and CJK wraps without inserting spaces', () => {
    const lines = mapSelectionLines([' ab你', ' 😀cd'], [' ab你😀cd']);
    expect(selectedText(lines, { anchor: { row: 0, column: 3 }, focus: { row: 1, column: 4 } })).toBe('你😀c');
  });

  it('copies reverse multi-row selections without styling escapes', () => {
    expect(selectedText(['\x1b[31m你😀 abc\x1b[39m', '  second'], {
      anchor: { row: 1, column: 5 }, focus: { row: 0, column: 2 },
    })).toBe('😀 abc\n  sec');
  });
});
