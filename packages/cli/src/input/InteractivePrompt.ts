import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { PromptBackError } from './PromptAbort';

export class InteractivePrompt {
  private readonly interface = readline.createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });

  async readUserMessage(
    label = 'user> ',
    options: { onEscape?: 'cancel' | 'back' } = {},
  ): Promise<string | undefined> {
    // readline does not treat a lone Esc as cancel. When asked, wire a keypress
    // listener to an AbortController so Esc rejects the question — letting callers
    // either cancel the command or step back a wizard stage. (readline emits
    // 'keypress' on the input in terminal mode; arrow keys carry names like 'up',
    // so only a bare Esc matches 'escape'.)
    const controller = options.onEscape && input.isTTY ? new AbortController() : undefined;
    const onKeypress = (_str: string, key: { name?: string } | undefined): void => {
      if (key?.name === 'escape') controller?.abort();
    };
    if (controller) input.on('keypress', onKeypress);
    try {
      return await (controller
        ? this.interface.question(label, { signal: controller.signal })
        : this.interface.question(label));
    } catch (error) {
      // Esc fired our controller → distinguish "step back" from a hard cancel.
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.onEscape === 'back') throw new PromptBackError();
        return undefined;
      }
      // Ctrl+C / Ctrl+D close the interface → always a cancel.
      if (error instanceof Error && error.message === 'readline was closed') return undefined;
      throw error;
    } finally {
      if (controller) input.off('keypress', onKeypress);
    }
  }

  async readMultilineMessage(label = 'user > ', continuationLabel = '... > '): Promise<string | undefined> {
    const lines: string[] = [];
    let prompt = label;

    while (true) {
      const line = await this.readUserMessage(prompt);
      if (line === undefined) return lines.length > 0 ? lines.join('\n') : undefined;

      if (!line.endsWith('\\')) {
        lines.push(line);
        return lines.join('\n');
      }

      lines.push(line.slice(0, -1));
      prompt = continuationLabel;
    }
  }

  close(): void {
    this.interface.close();
  }
}
