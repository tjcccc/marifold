import { stdin as input, stdout as output } from 'process';
import { InteractivePrompt } from './InteractivePrompt';
import { PromptAbortError } from './PromptAbort';

export async function readSecretLine(label: string, getFallbackPrompt: () => InteractivePrompt): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    const answer = await getFallbackPrompt().readUserMessage(label);
    if (answer === undefined) throw new PromptAbortError();
    return answer.trim();
  }

  output.write(label);
  const rawMode = Boolean(input.isRaw);
  let value = '';
  let settled = false;

  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode?.(rawMode);
      input.pause();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(value.trim());
    };

    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(new PromptAbortError());
    };

    const onData = (data: Buffer | string): void => {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003') {
          abort();
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\b' || char === '\x7f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    input.on('data', onData);
  });
}
