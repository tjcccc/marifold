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
    commandNames: ['help', 'chat', 'clear'],
    skillNames: ['translate'],
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
    expect(onSubmit).toHaveBeenCalledWith('hello');
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
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
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

  it('completes a command prefix on Tab', async () => {
    const { stdin, lastFrame } = renderInput();
    stdin.write('/ch');
    await delay();
    stdin.write('\t');
    await delay();
    expect(lastFrame()).toContain('/chat');
  });
});
