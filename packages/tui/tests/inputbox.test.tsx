import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { InputBox } from '../src/ui/InputBox.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 20));
const noop = () => {};

function renderInput(overrides: Partial<Parameters<typeof InputBox>[0]> = {}) {
  const onSubmit = vi.fn();
  const props = {
    onSubmit,
    onInterrupt: noop,
    history: [] as string[],
    commands: [{ name: 'help' }, { name: 'chat' }, { name: 'clear' }],
    skills: [{ name: 'translate' }],
    ...overrides,
  };
  return { onSubmit, ...render(<InputBox {...props} />) };
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
    stdin.write('/chat'); // exact command — menu shows a single, already-typed item
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
    stdin.write('/ch');
    await delay();
    stdin.write('\t');
    await delay();
    expect(lastFrame()).toContain('/chat');
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
});
