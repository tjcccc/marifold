import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { FullScreen } from '../src/ui/FullScreen.js';
import { InputBox } from '../src/ui/InputBox.js';
import { MouseContext, type MouseEvent } from '../src/ui/Mouse.js';
import { selectedText } from '../src/ui/selection.js';
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

  it('copies reverse multi-row selections without styling escapes', () => {
    expect(selectedText(['\x1b[31m你😀 abc\x1b[39m', '  second'], {
      anchor: { row: 1, column: 5 }, focus: { row: 0, column: 2 },
    })).toBe('😀 abc\n  sec');
  });
});
