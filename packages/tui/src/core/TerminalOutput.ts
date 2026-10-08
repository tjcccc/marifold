import { stripTerminalStrings } from '@marifold/core';

/** Ink's text sanitizer drops cursor movement from rendered content but keeps
 * OSC sequences, so model or tool output could write the clipboard (OSC 52),
 * retitle the window, or plant a misleading hyperlink. The TUI never renders
 * device-control strings itself (its own clipboard and mode sequences go to
 * the real stdout directly), so drop them from every frame; CSI layout and
 * colors pass through. */
export function inertTerminalOutput(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : undefined;
    return (stream.write as (...args: unknown[]) => boolean)(text === undefined ? chunk : stripTerminalStrings(text), ...rest);
  };
  return new Proxy(stream, {
    get(target, property) {
      if (property === 'write') return write;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
