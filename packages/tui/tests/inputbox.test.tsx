import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TerminalInput } from '../src/core/TerminalInput.js';
import { InputBox } from '../src/ui/InputBox.js';
import { listCommandCompletions } from '../src/core/commands.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 20));
const noop = () => {};

function renderInput(overrides: Partial<Parameters<typeof InputBox>[0]> = {}) {
  const onSubmit = vi.fn();
  const props = {
    onSubmit,
    onInterrupt: noop,
    history: [] as string[],
    commands: [{ name: 'help' }, { name: 'think' }, { name: 'clear' }],
    skills: [{ name: 'translate' }, { name: 'make-midjourney-prompt' }],
    ...overrides,
  };
  const result = render(<InputBox {...props} />);
  const input = new TerminalInput(process.stdin, false);
  input.on('data', (chunk: Buffer) => result.stdin.write(chunk.toString()));
  return { onSubmit, ...result, stdin: { write: (chunk: string) => input.write(chunk) }, unmount: () => { input.destroy(); result.unmount(); } };
}

describe('InputBox', () => {
  it('types and deletes with backspace (incl. macOS DEL 0x7f)', async () => {
    const { stdin, lastFrame } = renderInput();
    stdin.write('abc');
    await delay();
    expect(lastFrame()).toContain('abc');
    stdin.write('\x7f');
    await delay();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).not.toMatch(/abc/);
  });

  it('forward-deletes the character under the cursor with Fedora Del (ESC[3~)', async () => {
    const { stdin, lastFrame } = renderInput();
    stdin.write('abc');
    await delay();
    stdin.write('\x1b[D'); // cursor between b and c
    await delay();
    stdin.write('\x1b[3~'); // Del removes c, not b
    await delay();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).not.toMatch(/ac|abc/);
  });

  it.each([
    ['readline', '\x1bb', '\x1bf'],
    ['Option arrows', '\x1b[1;3D', '\x1b[1;3C'],
    ['Ctrl arrows', '\x1b[1;5D', '\x1b[1;5C'],
  ])('moves by words with %s, including punctuation boundaries', async (_name, left, right) => {
    const { stdin, onSubmit, unmount } = renderInput();
    try {
      stdin.write('first,second third');
      await delay();
      stdin.write(left);
      await delay();
      stdin.write(left);
      await delay();
      stdin.write(right);
      await delay();
      stdin.write('X');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('first,secondX third', []));
    } finally { unmount(); }
  });

  it.each(['\x1b\x7f', '\x1b\b', '\x1b[127;3u'])('deletes the previous word with Option+Backspace (%j), retaining text after the caret', async sequence => {
    const { stdin, onSubmit, unmount } = renderInput();
    try {
      stdin.write('first second third');
      await delay();
      stdin.write('\x1bb'); // start of third
      await delay();
      stdin.write(sequence); // delete second and the separator before third
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('first third', []));
    } finally { unmount(); }
  });

  it('handles word-editing boundaries and multiline Unicode without splitting graphemes', async () => {
    const { stdin, onSubmit, unmount } = renderInput();
    try {
      stdin.write('\x1bb'); // beginning of empty draft
      await delay();
      stdin.write('\x1b\x7f');
      await delay();
      stdin.write('one\n  cafe\u0301 😀   ');
      await delay();
      stdin.write('\x1b\x7f'); // skip separators and delete the previous Unicode word
      await delay();
      stdin.write('\x1bf'); // already at the end
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('one\n  ', []));
    } finally { unmount(); }
  });

  it('submits on Enter', async () => {
    const { stdin, onSubmit } = renderInput();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSubmit).toHaveBeenCalledWith('hello', []);
  });

  it('continues onto a new line when the line ends with a backslash', async () => {
    const { stdin, onSubmit } = renderInput();
    stdin.write('line1\\');
    await delay();
    stdin.write('\r'); // continuation, not submit
    await delay();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('line2');
    await delay();
    stdin.write('\r'); // submit
    await delay();
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2', []);
  });

  it('recalls history with the up arrow', async () => {
    const { stdin, lastFrame } = renderInput({ history: ['first', 'second'] });
    stdin.write('[A'); // up
    await delay();
    expect(lastFrame()).toContain('second');
    stdin.write('[A'); // up again
    await delay();
    expect(lastFrame()).toContain('first');
  });

  it('restores image attachments when recalling and modifying a prompt', async () => {
    const { stdin, onSubmit, unmount } = renderInput({
      history: [{ text: 'describe [image #1]', images: ['/tmp/original.png'] }],
    });
    try {
      stdin.write('\x1b[A');
      await delay();
      stdin.write(' in pink');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('describe [image #1] in pink', ['/tmp/original.png']));
      stdin.write('new message');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('new message', []));
    } finally { unmount(); }
  });

  it('restores draft attachments after browsing history and clears images for text-only entries', async () => {
    const { stdin, onSubmit, unmount } = renderInput({
      history: ['text only', { text: 'draft [image #1]', images: ['/tmp/draft.png'] }],
    });
    try {
      stdin.write('\x1b[A');
      await delay();
      stdin.write(' edited');
      await delay();
      stdin.write('\x1b[A'); // save the edited image draft and browse
      await delay();
      stdin.write('\x1b[A'); // text-only history
      await delay();
      stdin.write('\x1b[B');
      await delay();
      stdin.write('\x1b[B'); // restore the edited image draft
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('draft [image #1] edited', ['/tmp/draft.png']));
      stdin.write('\x1b[A');
      await delay();
      stdin.write('\x1b[A');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('text only', []));
    } finally { unmount(); }
  });

  it('moves the cursor between lines mid-draft, recalling history only at the first line', async () => {
    const { stdin, lastFrame } = renderInput({ history: ['oldcmd'] });
    stdin.write('aaa');
    await delay();
    stdin.write('\n'); // newline (Ctrl+J / LF), not submit
    await delay();
    stdin.write('bbb');
    await delay();
    // Cursor is on the last line → ↑ moves up a line, it must NOT recall history.
    stdin.write('\x1b[A');
    await delay();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('aaa');
    expect(frame).toContain('bbb');
    expect(frame).not.toContain('oldcmd');
    // Now on the first line → ↑ recalls history.
    stdin.write('\x1b[A');
    await delay();
    frame = lastFrame() ?? '';
    expect(frame).toContain('oldcmd');
  });

  it('recalls history through a fully-typed command (menu does not trap ↑)', async () => {
    const { stdin, lastFrame } = renderInput({ history: ['older', 'prev'] });
    stdin.write('/think'); // exact command — menu shows a single, already-typed item
    await delay();
    stdin.write('\x1b[A'); // ↑ must fall through to history, not cycle the menu
    await delay();
    expect(lastFrame()).toContain('prev');
    stdin.write('\x1b[A');
    await delay();
    expect(lastFrame()).toContain('older');
  });

  it('completes a command prefix on Tab', async () => {
    const { stdin, lastFrame } = renderInput();
    stdin.write('/th');
    await delay();
    stdin.write('\t');
    await delay();
    expect(lastFrame()).toContain('/think');
  });

  it.each([
    ['Update the skill $make-', 'Update the skill $make-midjourney-prompt '],
    ['Update the skill\n$make-', 'Update the skill\n$make-midjourney-prompt '],
    ['Please use /th', 'Please use /think '],
    ['Please use\n/th', 'Please use\n/think '],
  ])('completes an inline token at the caret: %s', async (draft, expected) => {
    const { stdin, lastFrame, onSubmit, unmount } = renderInput();
    try {
      // Bracketed paste keeps embedded newlines as literal draft content.
      stdin.write('\x1b[200~' + draft + '\x1b[201~');
      await delay();
      expect(lastFrame()).toContain(draft.includes('$') ? 'make-midjourney-prompt' : '/think');
      stdin.write('\t');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expected, []));
    } finally { unmount(); }
  });

  it('preserves surrounding text when completing a token with arguments and reopens the menu at its caret', async () => {
    const { stdin, onSubmit, unmount } = renderInput();
    try {
      stdin.write('before $make- #image after');
      await delay();
      stdin.write('\x01');
      await delay();
      for (let i = 0; i < 'before $make-'.length; i++) { stdin.write('\x1b[C'); await delay(); }
      stdin.write('\t');
      await delay();
      stdin.write('X');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('before $make-midjourney-prompt X#image after', []));
    } finally { unmount(); }
  });

  it('reopens skill suggestions while editing the head token with existing arguments', async () => {
    const { stdin, lastFrame } = renderInput();
    stdin.write('$ #anime1');
    await delay();
    stdin.write('\x01'); // Ctrl+A → start
    await delay();
    stdin.write('\x1b[C'); // caret immediately after $
    await delay();
    stdin.write('make');
    await delay();
    expect(lastFrame()).toContain('$make-midjourney-prompt');

    stdin.write('\t');
    await delay();
    expect(lastFrame()).toContain('$make-midjourney-prompt #anime1');
  });

  it('offers both canonical /resume and its discoverable /session compatibility alias', async () => {
    const commands = listCommandCompletions();
    const { stdin, lastFrame, unmount } = renderInput({ commands });
    stdin.write('/s');
    await delay();
    expect(lastFrame()).toContain('/session');
    expect(lastFrame()).toContain('Alias for /resume');
    stdin.write('\x15'); // Ctrl+U clears the prefix
    await delay();
    stdin.write('/res');
    await delay();
    expect(lastFrame()).toContain('resume');
    unmount();
  });

  it('inserts a newline (not garbage) for modified Enter escape sequences', async () => {
    for (const seq of ['\x1b[27;5;13~', '\x1b[13;5u']) {
      const { stdin, lastFrame, onSubmit } = renderInput();
      stdin.write('a');
      await delay();
      stdin.write(seq); // Ctrl+Enter (modifyOtherKeys / CSI-u)
      await delay();
      stdin.write('b');
      await delay();
      const frame = lastFrame() ?? '';
      expect(frame).not.toMatch(/27;5;13|13;5u/); // no raw escape leaked
      expect(onSubmit).not.toHaveBeenCalled(); // modified Enter does not submit
      expect(frame).toMatch(/a\n\s+b|a[\s\S]*\n[\s\S]*b/); // a and b on separate lines
    }
  });

  it('keeps the prompt gutter fixed and consumes a space at an automatic wrap boundary', async () => {
    const { stdin, lastFrame } = renderInput();
    // ink-testing-library exposes 100 columns. InputBox reserves two prompt
    // columns and one cursor column, leaving 97 source columns per visual line.
    stdin.write(`${'a'.repeat(97)} second`);
    await delay();

    const lines = (lastFrame() ?? '').split('\n');
    const first = lines.find(line => line.includes('a'.repeat(20)));
    const continuation = lines.find(line => line.includes('second'));
    expect(first?.startsWith('> ')).toBe(true);
    expect(continuation?.startsWith('  second')).toBe(true);
    expect(continuation?.startsWith('   second')).toBe(false);
  });
});
