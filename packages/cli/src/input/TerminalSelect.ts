import { stdin as defaultInput, stdout as defaultOutput } from 'process';
import { PromptAbortError } from './PromptAbort';

export interface TerminalSelectOption<T> {
  label: string;
  value: T;
}

type SelectInput = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

type SelectOutput = NodeJS.WriteStream;

export function canUseTerminalSelect(
  input: SelectInput = defaultInput,
  output: SelectOutput = defaultOutput,
): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
}

export async function selectTerminalOption<T>(
  message: string,
  options: TerminalSelectOption<T>[],
  config: {
    defaultIndex?: number;
    input?: SelectInput;
    output?: SelectOutput;
  } = {},
): Promise<T | undefined> {
  const input = config.input ?? defaultInput;
  const output = config.output ?? defaultOutput;
  if (!canUseTerminalSelect(input, output)) return undefined;
  if (options.length === 0) throw new PromptAbortError();

  const defaultIndex = clampIndex(config.defaultIndex ?? 0, options.length);
  const rawMode = Boolean(input.isRaw);
  let selectedIndex = defaultIndex;
  let rendered = false;
  let settled = false;

  input.setRawMode?.(true);
  input.resume();

  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode?.(rawMode);
      input.pause();
    };

    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      renderFinal();
      cleanup();
      resolve(value);
    };

    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(new PromptAbortError());
    };

    const onData = (data: Buffer | string): void => {
      const keys = parseKeys(data.toString('utf8'));
      for (const key of keys) {
        if (settled) return;
        handleKey(key);
      }
    };

    const handleKey = (key: string): void => {
      if (key === '\u0003' || key === '\x1b') {
        abort();
        return;
      }
      if (key === '\r' || key === '\n') {
        finish(options[selectedIndex].value);
        return;
      }
      if (key === '\x1b[A' || key === 'k') {
        selectedIndex = selectedIndex <= 0 ? options.length - 1 : selectedIndex - 1;
        render();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        selectedIndex = selectedIndex >= options.length - 1 ? 0 : selectedIndex + 1;
        render();
      }
    };

    const render = (): void => {
      const lineCount = options.length + 1;
      if (rendered) output.write(`\x1b[${lineCount}F`);
      output.write(`\x1b[2K? ${message} (Use arrow keys)\n`);
      options.forEach((option, index) => {
        const prefix = index === selectedIndex ? ' » ' : '   ';
        output.write(`\x1b[2K${prefix}${option.label}\n`);
      });
      rendered = true;
    };

    const renderFinal = (): void => {
      if (!rendered) return;
      const lineCount = options.length + 1;
      output.write(`\x1b[${lineCount}F`);
      output.write(`\x1b[2K? ${message} ${options[selectedIndex].label}\n`);
      options.forEach(() => output.write('\x1b[2K\n'));
      output.write(`\x1b[${options.length}F`);
    };

    input.on('data', onData);
    render();
  });
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function parseKeys(input: string): string[] {
  const keys: string[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char !== '\x1b') {
      keys.push(char);
      index += 1;
      continue;
    }

    const sequence = input.slice(index, index + 3);
    if (sequence === '\x1b[A' || sequence === '\x1b[B') {
      keys.push(sequence);
      index += 3;
      continue;
    }

    keys.push(char);
    index += 1;
  }

  return keys;
}
